/**
 * copy-web-assets.js
 *
 * Copies the customer-app web files into the Capacitor www/ directory.
 * This runs automatically before `cap sync` so the native project always
 * has the latest version of the web app bundled inside it.
 *
 * What it copies:
 *   - customer-app/index.html  →  www/index.html
 *   - customer-app/hero.png    →  www/hero.png
 *   - assets/*                 →  www/assets/*
 *
 * It also patches the HTML to fix asset paths (../assets/ → assets/)
 * since the native app serves from www/ not customer-app/.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');  // washroute repo root
const WWW  = path.resolve(__dirname, '..', 'www');

// Ensure www/ exists
if (!fs.existsSync(WWW)) fs.mkdirSync(WWW, { recursive: true });

// 1. Copy index.html and patch relative asset paths
console.log('Copying customer-app/index.html → www/index.html');
let html = fs.readFileSync(path.join(ROOT, 'customer-app', 'index.html'), 'utf8');

// Fix asset paths: ../assets/ → assets/  (native app serves from www/)
html = html.replace(/\.\.\/assets\//g, 'assets/');

// Add Capacitor bridge script before closing </head> tag
// This is what connects the web app to native plugins (push notifications, etc.)
if (!html.includes('capacitor.js')) {
  html = html.replace('</head>', '  <script src="capacitor.js"></script>\n</head>');
}

// Add native bridge script before closing </body> tag
// This handles push notifications, deep links, status bar, etc.
if (!html.includes('native-bridge.js')) {
  html = html.replace('</body>', '  <script src="native-bridge.js"></script>\n</body>');
}

// Add safe-area CSS for iOS notch/Dynamic Island
if (!html.includes('safe-area-inset')) {
  const safeAreaCSS = `
    /* Native app safe areas (iOS notch / Dynamic Island) */
    body { padding-top: env(safe-area-inset-top); padding-bottom: env(safe-area-inset-bottom); }
    .tab-bar, .bottom-nav { padding-bottom: env(safe-area-inset-bottom); }
  `;
  html = html.replace('</style>', safeAreaCSS + '\n  </style>');
}

fs.writeFileSync(path.join(WWW, 'index.html'), html, 'utf8');

// 2. Copy hero.png
const heroSrc = path.join(ROOT, 'customer-app', 'hero.png');
if (fs.existsSync(heroSrc)) {
  console.log('Copying customer-app/hero.png → www/hero.png');
  fs.copyFileSync(heroSrc, path.join(WWW, 'hero.png'));
}

// 3. Copy assets/ folder
const assetsSrc = path.join(ROOT, 'assets');
const assetsDst = path.join(WWW, 'assets');
if (!fs.existsSync(assetsDst)) fs.mkdirSync(assetsDst, { recursive: true });

if (fs.existsSync(assetsSrc)) {
  const files = fs.readdirSync(assetsSrc);
  let copied = 0;
  for (const file of files) {
    // Skip .DS_Store and other hidden files
    if (file.startsWith('.')) continue;
    const src = path.join(assetsSrc, file);
    const dst = path.join(assetsDst, file);
    if (fs.statSync(src).isFile()) {
      fs.copyFileSync(src, dst);
      copied++;
    }
  }
  console.log(`Copied ${copied} asset files → www/assets/`);
}

// 4. Copy native-bridge.js into www/
const bridgeSrc = path.join(__dirname, 'native-bridge.js');
if (fs.existsSync(bridgeSrc)) {
  console.log('Copying native-bridge.js → www/native-bridge.js');
  fs.copyFileSync(bridgeSrc, path.join(WWW, 'native-bridge.js'));
}

console.log('✅ Web assets ready for Capacitor sync');
