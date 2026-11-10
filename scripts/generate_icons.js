// scripts/generate_icons.js
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rootDir = path.resolve(__dirname, '..');
const iconsDir = path.resolve(rootDir, '414Extensions', 'icons');
const masterIconPath = path.resolve(iconsDir, 'master_icon.png');
const x414AssetsDir = path.resolve(rootDir, 'X414', 'assets');

if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir, { recursive: true });

// Check if Python and Pillow are available to resample master_icon.png with Lanczos and unsharp mask
let pythonResampled = false;
if (fs.existsSync(masterIconPath)) {
  try {
    const pyScript = `
import os
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

icons_dir = r"${iconsDir}"
master_path = r"${masterIconPath}"
x414_dir = r"${x414AssetsDir}"

master = Image.open(master_path).convert("RGBA")

# 128x128
im128 = master.resize((128, 128), Image.Resampling.LANCZOS)
im128.save(os.path.join(icons_dir, "icon128.png"))

# 48x48
enh48 = ImageEnhance.Contrast(master).enhance(1.15)
im48 = enh48.resize((48, 48), Image.Resampling.LANCZOS).filter(ImageFilter.UnsharpMask(radius=0.8, percent=110, threshold=2))
im48.save(os.path.join(icons_dir, "icon48.png"))

# 32x32
enh32 = ImageEnhance.Contrast(master).enhance(1.3)
sharp32 = ImageEnhance.Sharpness(enh32).enhance(1.3)
im32 = sharp32.resize((32, 32), Image.Resampling.LANCZOS).filter(ImageFilter.UnsharpMask(radius=0.9, percent=130, threshold=2))
im32.save(os.path.join(icons_dir, "icon32.png"))

# 16x16 pixel-tuned
im16 = Image.new("RGBA", (16, 16), (0, 0, 0, 0))
d16 = ImageDraw.Draw(im16)
d16.rounded_rectangle([0, 0, 15, 15], radius=4, fill=(10, 14, 24, 255), outline=(0, 220, 255, 230), width=1)
d16.point([(15, 8), (15, 9), (15, 10), (15, 11), (14, 12), (14, 13), (13, 14), (12, 14)], fill=(147, 51, 234, 240))
cyan = (0, 242, 254, 255)
violet = (168, 85, 247, 255)
white = (245, 250, 255, 255)
# Left 4
d16.point([(2, 5), (2, 6), (2, 7)], fill=cyan)
d16.point([(2, 8), (3, 8), (4, 8), (5, 8), (6, 8)], fill=cyan)
d16.point([(5, 4), (5, 5), (5, 6), (5, 7), (5, 8), (5, 9), (5, 10), (5, 11)], fill=cyan)
# Center 1
d16.point([(7, 5), (8, 4), (8, 5), (8, 6), (8, 7), (8, 8), (8, 9), (8, 10), (8, 11)], fill=white)
# Right 4
d16.point([(10, 5), (10, 6), (10, 7)], fill=violet)
d16.point([(10, 8), (11, 8), (12, 8), (13, 8), (14, 8)], fill=violet)
d16.point([(13, 4), (13, 5), (13, 6), (13, 7), (13, 8), (13, 9), (13, 10), (13, 11)], fill=violet)

im16.save(os.path.join(icons_dir, "icon16.png"))
im16.save(os.path.join(icons_dir, "default_icon.png"))

if os.path.exists(x414_dir):
    master.resize((256, 256), Image.Resampling.LANCZOS).save(os.path.join(x414_dir, "icon.png"))
    master.resize((256, 256), Image.Resampling.LANCZOS).save(os.path.join(x414_dir, "adaptive-icon.png"))
    master.resize((512, 512), Image.Resampling.LANCZOS).save(os.path.join(x414_dir, "splash.png"))

print("Pillow master resample complete.")
`;
    execSync('python -', { input: pyScript, stdio: ['pipe', 'inherit', 'inherit'] });
    pythonResampled = true;
  } catch (err) {
    console.warn('Python Pillow resampling skipped, falling back to pure Node generator:', err.message);
  }
}

if (!pythonResampled) {
  // Pure Node.js fallback PNG generator
  function crc32(buf) {
    let table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[i] = c >>> 0;
    }
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
      crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function createChunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const body = Buffer.concat([typeBuf, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
  }

  function encodePNG(width, height, rgbaBuffer) {
    const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;
    const ihdrChunk = createChunk('IHDR', ihdr);

    const scanlines = Buffer.alloc(height * (1 + width * 4));
    for (let y = 0; y < height; y++) {
      const scanlineOffset = y * (1 + width * 4);
      scanlines[scanlineOffset] = 0;
      const rowData = rgbaBuffer.subarray(y * width * 4, (y + 1) * width * 4);
      rowData.copy(scanlines, scanlineOffset + 1);
    }
    const compressed = zlib.deflateSync(scanlines, { level: 9 });
    const idatChunk = createChunk('IDAT', compressed);
    const iendChunk = createChunk('IEND', Buffer.alloc(0));

    return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
  }

  function renderFallbackIcon(size) {
    const buf = Buffer.alloc(size * size * 4);
    const radius = size * 0.46;
    const cx = size / 2;
    const cy = size / 2;

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const idx = (y * size + x) * 4;
        const dx = x - cx;
        const dy = y - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist <= radius) {
          const t = (x + y) / (2 * size);
          const r = Math.round(10 * (1 - t) + 147 * t);
          const g = Math.round(180 * (1 - t) + 51 * t);
          const b = Math.round(255 * (1 - t) + 234 * t);
          buf[idx] = r;
          buf[idx + 1] = g;
          buf[idx + 2] = b;
          buf[idx + 3] = 255;
        } else {
          buf[idx + 3] = 0;
        }
      }
    }
    return encodePNG(size, size, buf);
  }

  for (const s of [16, 32, 48, 128]) {
    const pngBuf = renderFallbackIcon(s);
    const outPath = path.join(iconsDir, `icon${s}.png`);
    fs.writeFileSync(outPath, pngBuf);
  }
}

console.log('414 Extensions icons generated successfully!');
