package au.tomat.ing

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  // Edge-to-edge keeps the activity window full-screen even while the soft
  // keyboard is up, so the WebView never resizes for the IME. On this platform
  // that means the two signals the web layer would normally use are both dead:
  // CSS env(safe-area-inset-*) reads 0 on Android WebView, and JS
  // window.visualViewport never reports the keyboard (tauri-apps/tauri#10631).
  // We therefore read the insets natively and publish them to the page as CSS
  // variables, which the mobile shell consumes for ALL inset/keyboard layout:
  //   --safe-area-inset-{top,right,bottom,left}  static device chrome
  //       (status / gesture bars + display cutout), and
  //   --keyboard-inset  the soft-keyboard height in CSS px (0 when hidden).
  // The frame pads its bottom by max(safe-bottom, keyboard) so the composer
  // rides above whichever is taller; fixed sheets lift by --keyboard-inset.
  override fun onWebViewCreate(webView: WebView) {
    ViewCompat.setOnApplyWindowInsetsListener(webView) { _, insets ->
      val density = webView.resources.displayMetrics.density
      fun cssPx(px: Int): Int = (px / density).toInt()
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
      )
      val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
      val js = """
        (function () {
          var s = document.documentElement.style;
          s.setProperty('--safe-area-inset-top', '${cssPx(bars.top)}px');
          s.setProperty('--safe-area-inset-right', '${cssPx(bars.right)}px');
          s.setProperty('--safe-area-inset-bottom', '${cssPx(bars.bottom)}px');
          s.setProperty('--safe-area-inset-left', '${cssPx(bars.left)}px');
          s.setProperty('--keyboard-inset', '${cssPx(keyboard)}px');
        })();
      """.trimIndent()
      webView.evaluateJavascript(js, null)
      // Return the insets unconsumed (the documented pattern); we supply the page
      // its inset values via the CSS variables above rather than via env().
      insets
    }
    // Kick a first inset pass now; keyboard show/hide re-fires the listener.
    webView.requestApplyInsets()
  }
}
