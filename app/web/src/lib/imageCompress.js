// 图片压缩：把手机照片压到「长边 ≤1300px、JPEG 质量 0.85」
//
// 为什么必须压（实测数据，别删这段注释）：
//   1. 上游模型对图像有固定预处理：较大的图会被缩到约 1300×1300 的像素总量，
//      每张图最多 1024 tokens。也就是说传 4000px 的原图，细节照样被丢掉，
//      白等白传还多花流量 —— 压缩不损失有效信息，只省时间。
//   2. 服务器单张图上限 2MB（base64 后）。iPhone 原图 base64 后常有 4-8MB，不压直接被拒。
//   3. 服务端 bodyLimit 8MB / 单轮 3 张，不压很容易触顶。
//
// 保真优先：压完若比原图还大（已压过的小图），就用原图。

const MAX_EDGE = 1300;
const QUALITY = 0.85;

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片解码失败')); };
    img.src = url;
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('图片编码失败'))), type, quality);
  });
}

function blobToDataURI(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => reject(new Error('图片读取失败'));
    fr.readAsDataURL(blob);
  });
}

// 主入口：吃一个 File，吐出 { blob, uri, mime, width, height }
export async function compressImage(file) {
  if (!file || !/^image\//.test(file.type || '')) throw new Error('不是图片文件');
  // 只接受上游支持的四种格式
  if (!/^image\/(jpeg|png|gif|webp)$/.test(file.type)) {
    throw new Error('仅支持 JPG / PNG / GIF / WebP 格式');
  }

  const img = await loadImage(file);
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (!w || !h) throw new Error('图片尺寸无效');

  const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));

  const canvas = document.createElement('canvas');
  canvas.width = tw;
  canvas.height = th;
  const ctx = canvas.getContext('2d');
  // 白底：PNG 透明区域转 JPEG 会变黑，先铺白
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, tw, th);
  ctx.drawImage(img, 0, 0, tw, th);

  // GIF 避免转 JPEG（会丢帧/动画语义），统一走 JPEG 是因为它是舌象等实拍图的最优选择；
  // 对 PNG/GIF 这类可能含文字的截图，JPEG 也够用且体积小得多。
  let blob = await canvasToBlob(canvas, 'image/jpeg', QUALITY);
  if (!blob) throw new Error('图片处理失败');
  // 压完反而更大（原图已是很小的高压 JPEG）→ 用原图
  if (blob.size >= file.size && file.size > 0) {
    blob = file;
  }
  if (blob.size > 2 * 1024 * 1024) {
    throw new Error('图片过大，请换一张或先裁剪');
  }

  const uri = await blobToDataURI(blob);
  return { blob, uri, mime: blob.type || 'image/jpeg', width: tw, height: th };
}

export const IMAGE_LIMITS = { MAX_EDGE, MAX_COUNT: 3 };
