//! Pinned network access to a paired core.
//!
//! The webview can't pin a self-signed certificate (browser fetch/WebSocket
//! expose no pinning API), so all core traffic is terminated here in Rust with
//! a custom rustls verifier that checks the server cert's SubjectPublicKeyInfo
//! against the base64 SHA-256 pin captured at pairing. HTTP uses reqwest; the
//! WebSocket uses tokio-tungstenite. Both share `build_client_config`.
//!
//! `capture_pin` (used only during the pairing TOFU handshake) accepts whatever
//! cert is presented and reports its pin instead of enforcing one. The PAKE key
//! confirmation then binds that pin, so a MITM is caught at the application
//! layer even though TLS here didn't reject it.

use crate::error::{AppError, AppResult};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, SignatureScheme};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async_tls_with_config, Connector};

// One shared crypto provider (rustls' default: aws-lc-rs). The pin verifier
// delegates signature checks to it, so the TLS handshake still proves the
// server holds the cert's private key; we only override chain/name validation.
static PROVIDER: LazyLock<Arc<rustls::crypto::CryptoProvider>> =
    LazyLock::new(|| Arc::new(rustls::crypto::aws_lc_rs::default_provider()));

// Live WebSocket senders, keyed by the JS-generated wsId.
static WS_HANDLES: LazyLock<Mutex<HashMap<String, mpsc::UnboundedSender<WsOut>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

enum WsOut {
    Text(String),
    Close,
}

// --- pin verifier ---------------------------------------------------------

#[derive(Debug)]
struct SpkiPinVerifier {
    /// Expected SHA-256 of the cert's SPKI. `None` = capture mode (accept any).
    pin: Option<[u8; 32]>,
    /// Filled with the presented cert's SPKI hash on every handshake.
    captured: Arc<Mutex<Option<[u8; 32]>>>,
    provider: Arc<rustls::crypto::CryptoProvider>,
}

impl ServerCertVerifier for SpkiPinVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let hash = spki_sha256(end_entity)
            .ok_or_else(|| rustls::Error::General("certificate parse failed".into()))?;
        if let Ok(mut g) = self.captured.lock() {
            *g = Some(hash);
        }
        match self.pin {
            Some(expected) if constant_time_eq(&expected, &hash) => {
                Ok(ServerCertVerified::assertion())
            }
            Some(_) => Err(rustls::Error::General("certificate pin mismatch".into())),
            None => Ok(ServerCertVerified::assertion()), // TOFU capture mode
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

fn spki_sha256(cert: &CertificateDer<'_>) -> Option<[u8; 32]> {
    use x509_parser::prelude::*;
    let (_, parsed) = X509Certificate::from_der(cert.as_ref()).ok()?;
    let mut h = Sha256::new();
    h.update(parsed.public_key().raw);
    Some(h.finalize().into())
}

fn constant_time_eq(a: &[u8; 32], b: &[u8; 32]) -> bool {
    let mut diff = 0u8;
    for i in 0..32 {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

fn parse_pin(pin: Option<String>) -> AppResult<Option<[u8; 32]>> {
    match pin {
        None => Ok(None),
        Some(s) => {
            let bytes = B64
                .decode(s.as_bytes())
                .map_err(|e| AppError::validation(format!("bad pin: {e}")))?;
            let arr: [u8; 32] = bytes
                .try_into()
                .map_err(|_| AppError::validation("pin must be 32 bytes (SHA-256)"))?;
            Ok(Some(arr))
        }
    }
}

fn build_client_config(
    pin: Option<[u8; 32]>,
    captured: Arc<Mutex<Option<[u8; 32]>>>,
) -> AppResult<ClientConfig> {
    let verifier = Arc::new(SpkiPinVerifier {
        pin,
        captured,
        provider: PROVIDER.clone(),
    });
    Ok(ClientConfig::builder_with_provider(PROVIDER.clone())
        .with_safe_default_protocol_versions()
        .map_err(|e| AppError::external(format!("tls config: {e}")))?
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth())
}

// --- HTTP -----------------------------------------------------------------

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetFetchReply {
    status: u16,
    headers: HashMap<String, String>,
    body_b64: String,
    captured_pin: Option<String>,
}

/// One pinned HTTP request. `body_b64`/the reply body are base64 to cross IPC.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn net_fetch(
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body_b64: Option<String>,
    pin: Option<String>,
    capture_pin: bool,
) -> AppResult<NetFetchReply> {
    let captured = Arc::new(Mutex::new(None));
    let tls = build_client_config(parse_pin(pin)?, captured.clone())?;
    let client = reqwest::Client::builder()
        .use_preconfigured_tls(tls)
        // Without explicit timeouts a stalled core (e.g. a wedged TLS handshake
        // or a peer that accepts but never replies) hangs `send().await`
        // forever. On the boot path this awaited request gates the window-show
        // and first render (see +page.svelte onMount), so an unbounded hang
        // leaves the app running with no window. Bound both phases.
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| AppError::external(format!("http client: {e}")))?;

    let method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|e| AppError::validation(format!("bad method: {e}")))?;
    let mut header_map = reqwest::header::HeaderMap::new();
    for (k, v) in &headers {
        if let (Ok(name), Ok(val)) = (
            reqwest::header::HeaderName::from_bytes(k.as_bytes()),
            reqwest::header::HeaderValue::from_str(v),
        ) {
            header_map.insert(name, val);
        }
    }
    let mut req = client.request(method, &url).headers(header_map);
    if let Some(b64) = body_b64 {
        req = req.body(
            B64.decode(b64.as_bytes())
                .map_err(|e| AppError::validation(format!("bad body: {e}")))?,
        );
    }

    let resp = req
        .send()
        .await
        .map_err(|e| AppError::external(format!("request failed: {e}")))?;
    let status = resp.status().as_u16();
    let mut out_headers = HashMap::new();
    for (k, v) in resp.headers() {
        if let Ok(s) = v.to_str() {
            out_headers.insert(k.as_str().to_lowercase(), s.to_string());
        }
    }
    let body = resp
        .bytes()
        .await
        .map_err(|e| AppError::external(format!("read body: {e}")))?;

    let captured_pin = if capture_pin {
        captured.lock().ok().and_then(|g| *g).map(|h| B64.encode(h))
    } else {
        None
    };

    Ok(NetFetchReply {
        status,
        headers: out_headers,
        body_b64: B64.encode(&body),
        captured_pin,
    })
}

// --- WebSocket ------------------------------------------------------------

fn ev(ws_id: &str, kind: &str) -> String {
    format!("net://ws/{ws_id}/{kind}")
}

/// Open a pinned WebSocket. Frames are forwarded to JS as per-id Tauri events
/// (`net://ws/<id>/{open,message,close,error}`); send/close go through the
/// channel stored under `ws_id`. Returns immediately; connect runs in the task.
#[tauri::command]
pub async fn net_ws_open(
    app: AppHandle,
    ws_id: String,
    url: String,
    pin: Option<String>,
) -> AppResult<()> {
    let tls = build_client_config(parse_pin(pin)?, Arc::new(Mutex::new(None)))?;
    let (tx, mut rx) = mpsc::unbounded_channel::<WsOut>();
    if let Ok(mut m) = WS_HANDLES.lock() {
        m.insert(ws_id.clone(), tx);
    }

    tokio::spawn(async move {
        let connector = Connector::Rustls(Arc::new(tls));
        let stream = match connect_async_tls_with_config(&url, None, false, Some(connector)).await {
            Ok((s, _)) => s,
            Err(e) => {
                // Surface the connect failure reason (e.g. "Connection refused
                // (os error 61)", TLS/pin errors) so the client can show it in
                // the reconnect banner instead of a generic message.
                let _ = app.emit(&ev(&ws_id, "error"), e.to_string());
                let _ = app.emit(&ev(&ws_id, "close"), ());
                remove_handle(&ws_id);
                return;
            }
        };
        let _ = app.emit(&ev(&ws_id, "open"), ());
        let (mut write, mut read) = stream.split();
        loop {
            tokio::select! {
                out = rx.recv() => match out {
                    Some(WsOut::Text(s)) => {
                        if write.send(Message::Text(s.into())).await.is_err() { break; }
                    }
                    Some(WsOut::Close) | None => {
                        let _ = write.send(Message::Close(None)).await;
                        break;
                    }
                },
                msg = read.next() => match msg {
                    Some(Ok(Message::Text(t))) => {
                        let _ = app.emit(&ev(&ws_id, "message"), t.to_string());
                    }
                    Some(Ok(Message::Ping(p))) => {
                        let _ = write.send(Message::Pong(p)).await;
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                },
            }
        }
        remove_handle(&ws_id);
        let _ = app.emit(&ev(&ws_id, "close"), ());
    });

    Ok(())
}

#[tauri::command]
pub fn net_ws_send(ws_id: String, data: String) -> AppResult<()> {
    if let Ok(m) = WS_HANDLES.lock() {
        if let Some(tx) = m.get(&ws_id) {
            let _ = tx.send(WsOut::Text(data));
        }
    }
    Ok(())
}

#[tauri::command]
pub fn net_ws_close(ws_id: String) -> AppResult<()> {
    if let Ok(m) = WS_HANDLES.lock() {
        if let Some(tx) = m.get(&ws_id) {
            let _ = tx.send(WsOut::Close);
        }
    }
    Ok(())
}

fn remove_handle(ws_id: &str) {
    if let Ok(mut m) = WS_HANDLES.lock() {
        m.remove(ws_id);
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use rustls::pki_types::{ServerName, UnixTime};

    // A fresh self-signed ECDSA cert (rcgen), as the wire `CertificateDer`.
    fn self_signed() -> CertificateDer<'static> {
        rcgen::generate_simple_self_signed(vec!["127.0.0.1".to_string()])
            .unwrap()
            .cert
            .der()
            .clone()
    }

    fn make_verifier(
        pin: Option<[u8; 32]>,
        captured: Arc<Mutex<Option<[u8; 32]>>>,
    ) -> SpkiPinVerifier {
        SpkiPinVerifier {
            pin,
            captured,
            provider: PROVIDER.clone(),
        }
    }

    fn run_verify(v: &SpkiPinVerifier, der: &CertificateDer<'_>) -> Result<(), rustls::Error> {
        let name = ServerName::try_from("127.0.0.1").unwrap();
        v.verify_server_cert(der, &[], &name, &[], UnixTime::now())
            .map(|_| ())
    }

    #[test]
    fn capture_mode_records_the_presented_spki_pin() {
        let der = self_signed();
        let captured = Arc::new(Mutex::new(None));
        let v = make_verifier(None, captured.clone());
        assert!(run_verify(&v, &der).is_ok());
        assert_eq!(
            captured.lock().unwrap().unwrap(),
            spki_sha256(&der).unwrap()
        );
    }

    #[test]
    fn pin_mode_accepts_match_and_rejects_mismatch() {
        let der = self_signed();
        let pin = spki_sha256(&der).unwrap();
        // Matching pin → accepted.
        let good = make_verifier(Some(pin), Arc::new(Mutex::new(None)));
        assert!(run_verify(&good, &der).is_ok());
        // One flipped byte (the MITM-presents-a-different-cert case) → rejected.
        let mut wrong = pin;
        wrong[0] ^= 0xff;
        let bad = make_verifier(Some(wrong), Arc::new(Mutex::new(None)));
        assert!(run_verify(&bad, &der).is_err());
    }

    #[test]
    fn parse_pin_roundtrips_a_32_byte_pin() {
        let raw = [7u8; 32];
        assert_eq!(parse_pin(Some(B64.encode(raw))).unwrap(), Some(raw));
    }

    #[test]
    fn parse_pin_none_is_none() {
        assert_eq!(parse_pin(None).unwrap(), None);
    }

    #[test]
    fn parse_pin_rejects_wrong_length() {
        // 31 bytes is not a SHA-256 digest.
        assert!(parse_pin(Some(B64.encode([0u8; 31]))).is_err());
    }

    #[test]
    fn parse_pin_rejects_non_base64() {
        assert!(parse_pin(Some("not base64!!".to_string())).is_err());
    }

    #[test]
    fn constant_time_eq_distinguishes_pins() {
        let a = [1u8; 32];
        let mut b = [1u8; 32];
        assert!(constant_time_eq(&a, &b));
        b[31] = 2;
        assert!(!constant_time_eq(&a, &b));
    }
}
