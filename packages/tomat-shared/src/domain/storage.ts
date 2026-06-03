// On-disk storage view for the Settings "Storage" field. The core walks its
// content (downloaded models being the disk-space-significant part) and returns
// this tree; the client renders it and routes deletes back through the storage
// API. Field names are snake_case to match the tree the UI's pure helpers
// (storage-tree.ts) already consume.

export type StorageFile = {
  kind: "file";
  name: string;
  path: string;
  size: number;
};

export type StorageFolder = {
  kind: "folder";
  name: string;
  path: string;
  size: number;
  children: StorageNode[];
};

export type StorageNode = StorageFile | StorageFolder;

export type StorageTree = {
  models: StorageNode[];
  // Sessions live in SQLite (owned per client, managed from the session bar)
  // and snippets are client-local (in ~/.tomat/client/settings.json, managed in
  // the Snippets settings field), so neither is part of the core's disk view;
  // the core leaves these empty. The shape is kept so the UI helpers stay general.
  sessions: StorageNode[];
  snippets: StorageNode[];
  total_size: number;
  models_size: number;
  sessions_size: number;
  snippets_size: number;
  settings_size: number;
  /** Base dir whose `/models` child holds the model files, so the UI can map
   *  an HF spec to its on-disk path for in-use locking. */
  root_path: string;
};
