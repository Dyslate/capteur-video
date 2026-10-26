// Turning a chrome.downloads.DownloadItem into a job patch, kept pure so it can be unit-tested.

// Last path segment, for both Windows (\) and POSIX (/) separators.
export function baseName(path) {
  return String(path || "").split(/[\\/]/).pop() || "";
}

// item: a chrome.downloads.DownloadItem (or undefined before it appears).
// formatBytes: a byte formatter (U.formatBytes).
// Returns a patch for the job, or null when the item is not known yet.
export function progressFromItem(item, formatBytes) {
  if (!item) return null;
  if (item.state === "in_progress") {
    const total = item.totalBytes > 0 ? item.totalBytes : null;
    const received = item.bytesReceived || 0;
    const head = item.paused ? "Paused… " : "Downloading… ";
    return {
      progress: total ? received / total : null,
      status: head + (total ? `${formatBytes(received)} / ${formatBytes(total)}` : formatBytes(received)),
    };
  }
  if (item.state === "complete") {
    const size = item.fileSize || item.totalBytes || item.bytesReceived || 0;
    return { done: true, progress: 1, downloadId: item.id, filename: item.filename, status: `Saved: ${baseName(item.filename)} (${formatBytes(size)})` };
  }
  // interrupted
  const cancelled = item.error === "USER_CANCELED";
  return { error: cancelled ? "download cancelled" : "download interrupted" + (item.error ? ` (${item.error})` : "") };
}

// Whether a thrown download error means the user dismissed the "Save as" dialog.
export function isUserCancel(message) {
  return /cancel/i.test(String(message || ""));
}
