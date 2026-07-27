const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const IMG_DIR = 'images';
const QUALITY = 70;

async function main() {
  const files = fs.readdirSync(IMG_DIR).filter(f => /\.jpg$/i.test(f)).sort();
  const total = files.length;
  let processed = 0;
  let originalBytes = 0;
  let compressedBytes = 0;
  let errors = 0;

  const start = Date.now();
  let lastLog = 0;

  for (let i = 0; i < total; i++) {
    const f = files[i];
    const fp = path.join(IMG_DIR, f);
    try {
      const input = fs.readFileSync(fp);
      originalBytes += input.length;
      const buf = await sharp(input).jpeg({ quality: QUALITY, mozjpeg: true }).toBuffer();
      fs.writeFileSync(fp, buf);
      compressedBytes += buf.length;
      processed++;
    } catch (e) {
      errors++;
    }

    const elapsed = Date.now() - start;
    if (elapsed - lastLog > 60000 || i === total - 1) {
      lastLog = elapsed;
      const pct = Math.round((i + 1) / total * 100);
      const saved = originalBytes > 0 ? ((1 - compressedBytes / originalBytes) * 100).toFixed(1) : '0.0';
      console.log(`${processed}/${total} (${pct}%) - ahorrado ${saved}% - ${(elapsed/60000).toFixed(1)}min - errores: ${errors}`);
    }
  }

  const totalMB = (originalBytes / 1024 / 1024).toFixed(1);
  const finalMB = (compressedBytes / 1024 / 1024).toFixed(1);
  const savedMB = ((originalBytes - compressedBytes) / 1024 / 1024).toFixed(1);
  console.log(`\nHecho: ${totalMB}MB → ${finalMB}MB (ahorrado ${savedMB}MB) - ${errors} errores`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
