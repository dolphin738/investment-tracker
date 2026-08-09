/**
 * features/data-transfer/csv-download.ts — Blob 下载触发（T05）
 *
 * 统一通过临时 <a download> 触发浏览器下载；调用方负责把 Content-Disposition
 * 或本地拼接的文件名传入。
 */

/** 触发浏览器下载 Blob */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** 文件名做文件系统安全清洗（与后端 buildExportFilename 同规则） */
export function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '_').trim();
  return cleaned || 'portfolio';
}
