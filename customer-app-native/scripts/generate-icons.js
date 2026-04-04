/**
 * generate-icons.js
 *
 * Generates all required app icon sizes for iOS and Android
 * from the source icon (assets/icon-customer.png, 512x512).
 *
 * PREREQUISITES:
 *   npm install sharp --save-dev
 *
 * USAGE:
 *   node scripts/generate-icons.js
 *
 * This creates:
 *   resources/icon-1024.png   (iOS App Store)
 *   resources/icon-180.png    (iOS home screen @3x)
 *   resources/icon-167.png    (iPad Pro)
 *   resources/icon-152.png    (iPad)
 *   resources/icon-120.png    (iOS home screen @2x)
 *   resources/icon-512.png    (Android Play Store)
 *   resources/icon-192.png    (Android launcher xxxhdpi)
 *   resources/icon-144.png    (Android xxhdpi)
 *   resources/icon-96.png     (Android xhdpi)
 *   resources/icon-72.png     (Android hdpi)
 *   resources/icon-48.png     (Android mdpi)
 *   resources/splash-2732x2732.png  (splash screen)
 *
 * After running this, use `npx cap sync` to copy into native projects.
 */

const sharp = require('sharp');
const path  = require('path');
const fs    = require('fs');

const SOURCE  = path.resolve(__dirname, '..', '..', 'assets', 'icon-customer.png');
const OUT_DIR = path.resolve(__dirname, '..', 'resources');

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const SIZES = [
  { name: 'icon-1024.png',  size: 1024 },  // iOS App Store
  { name: 'icon-512.png',   size: 512  },  // Android Play Store
  { name: 'icon-192.png',   size: 192  },  // Android xxxhdpi
  { name: 'icon-180.png',   size: 180  },  // iOS @3x
  { name: 'icon-167.png',   size: 167  },  // iPad Pro
  { name: 'icon-152.png',   size: 152  },  // iPad
  { name: 'icon-144.png',   size: 144  },  // Android xxhdpi
  { name: 'icon-120.png',   size: 120  },  // iOS @2x
  { name: 'icon-96.png',    size: 96   },  // Android xhdpi
  { name: 'icon-72.png',    size: 72   },  // Android hdpi
  { name: 'icon-48.png',    size: 48   },  // Android mdpi
];

async function generate() {
  console.log(`Source icon: ${SOURCE}`);

  // Generate all icon sizes
  for (const { name, size } of SIZES) {
    const out = path.join(OUT_DIR, name);
    await sharp(SOURCE)
      .resize(size, size, { fit: 'cover' })
      .png()
      .toFile(out);
    console.log(`  ✅ ${name} (${size}×${size})`);
  }

  // Generate splash screen (centered logo on navy background)
  const SPLASH_SIZE = 2732;  // Largest iPad size
  const LOGO_SIZE   = 600;   // Logo in center

  const logoBuffer = await sharp(SOURCE)
    .resize(LOGO_SIZE, LOGO_SIZE, { fit: 'contain', background: { r: 15, g: 39, b: 68, alpha: 0 } })
    .png()
    .toBuffer();

  await sharp({
    create: {
      width: SPLASH_SIZE,
      height: SPLASH_SIZE,
      channels: 4,
      background: { r: 15, g: 39, b: 68, alpha: 255 }  // --navy: #0f2744
    }
  })
    .composite([{
      input: logoBuffer,
      gravity: 'centre'
    }])
    .png()
    .toFile(path.join(OUT_DIR, 'splash-2732x2732.png'));

  console.log(`  ✅ splash-2732x2732.png (${SPLASH_SIZE}×${SPLASH_SIZE})`);
  console.log('\n✅ All icons and splash screen generated in resources/');
  console.log('   Next step: npx cap sync');
}

generate().catch(err => {
  console.error('Error generating icons:', err.message);
  process.exit(1);
});
