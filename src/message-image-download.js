import { validateImageUrl, safeFetchBinary } from './safe-fetch.js';

const staleLink = error => /^HTTP (400|401|403|404|410)$/.test(String(error?.message || ''));
const opaqueFile = file => typeof file === 'string' && file.length > 0 && !/[\\/:]/.test(file) && !file.includes('..');

async function fetchImage(url, signal) {
  signal?.throwIfAborted();
  const safeUrl = await validateImageUrl(url);
  return safeFetchBinary(safeUrl, undefined, { signal });
}

// The caller supplies media from an already scoped message, never a model-supplied
// disk path. QQ CDN links expire; refresh the same opaque image ID once on expiry.
export async function downloadMessageImage(source, { onebot, signal, download = fetchImage } = {}) {
  signal?.throwIfAborted();
  let originalError;
  if (source.url) {
    const url = new URL(source.url);
    if (url.hostname === 'multimedia.nt.qq.com.cn' && url.pathname === '/download') {
      url.searchParams.set('spec', '720');
    }
    try {
      return await download(url.toString(), signal);
    } catch (error) {
      signal?.throwIfAborted();
      if (!staleLink(error)) throw error;
      originalError = error;
    }
  }
  if (!opaqueFile(source.file) || !onebot?.call) {
    throw originalError || new Error('图片没有可用链接或 OneBot 文件 ID');
  }
  try {
    const image = await onebot.call('get_image', { file: source.file }, null, { querySignal: signal });
    signal?.throwIfAborted();
    if (!image?.url) throw new Error('OneBot 未返回有效图片链接');
    // Revalidate the refreshed URL too; never bypass SSRF checks or read a returned
    // local file path. Keep its signed parameters intact.
    return await download(String(image.url), signal);
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error(`图片链接刷新后仍获取失败：${error?.message || error}`);
  }
}
