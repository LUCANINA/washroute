/**
 * native-bridge.js
 *
 * This file gets injected into the customer app's index.html to connect
 * the web UI with native Capacitor plugins. It handles:
 *
 *   1. Push notification registration + token storage
 *   2. Deep link handling (opening specific orders from notifications)
 *   3. Status bar styling
 *   4. Keyboard behavior on iOS
 *   5. App lifecycle (resume/pause)
 *
 * The copy-web-assets.js script injects this into the built HTML.
 * On the regular web version (Vercel), this file doesn't exist,
 * so everything degrades gracefully — no errors, no broken features.
 */

// Only run if we're inside a Capacitor native shell
if (window.Capacitor && window.Capacitor.isNativePlatform()) {

  document.addEventListener('DOMContentLoaded', async () => {

    // ── STATUS BAR ──
    try {
      const { StatusBar, Style } = await import('@capacitor/status-bar');
      await StatusBar.setStyle({ style: Style.Dark });
      await StatusBar.setBackgroundColor({ color: '#0f2744' });
    } catch (e) { /* plugin not available */ }

    // ── KEYBOARD (iOS) ──
    try {
      const { Keyboard } = await import('@capacitor/keyboard');
      Keyboard.addListener('keyboardWillShow', () => {
        document.body.classList.add('keyboard-open');
      });
      Keyboard.addListener('keyboardWillHide', () => {
        document.body.classList.remove('keyboard-open');
      });
    } catch (e) { /* plugin not available */ }

    // ── PUSH NOTIFICATIONS ──
    try {
      const { PushNotifications } = await import('@capacitor/push-notifications');

      // Request permission
      const perm = await PushNotifications.requestPermissions();
      if (perm.receive === 'granted') {
        await PushNotifications.register();
      }

      // When we get a token, save it to the customer's profile in Supabase
      PushNotifications.addListener('registration', async (token) => {
        console.log('[Native] Push token:', token.value);
        // Save token to Supabase so the backend can send pushes
        // This runs after the customer is logged in
        const saveToken = async () => {
          if (typeof db !== 'undefined' && typeof currentCustomer !== 'undefined' && currentCustomer?.id) {
            await db.from('customer_push_tokens').upsert({
              customer_id: currentCustomer.id,
              token: token.value,
              platform: window.Capacitor.getPlatform(), // 'ios' or 'android'
              updated_at: new Date().toISOString()
            }, { onConflict: 'customer_id,token' });
            console.log('[Native] Push token saved to Supabase');
          }
        };
        // Try now, and also retry after login
        saveToken();
        window._pendingPushToken = token.value;
      });

      // Handle notification received while app is open
      PushNotifications.addListener('pushNotificationReceived', (notification) => {
        console.log('[Native] Notification received:', notification);
        // Show an in-app toast instead of native banner (app is already open)
        if (typeof showToast === 'function') {
          showToast(notification.body || notification.title, 'info');
        }
      });

      // Handle notification tap (app was in background or closed)
      PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
        console.log('[Native] Notification tapped:', action);
        const data = action.notification.data;
        // If the notification includes an order_id, open that order
        if (data?.order_id && typeof showScreen === 'function') {
          showScreen('orders');
          // Small delay to let the screen render, then scroll to the order
          setTimeout(() => {
            const el = document.querySelector(`[data-order-id="${data.order_id}"]`);
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }, 500);
        }
      });

    } catch (e) {
      console.log('[Native] Push notifications not available:', e.message);
    }

    // ── APP LIFECYCLE ──
    try {
      const { App } = await import('@capacitor/app');

      // When app comes back to foreground, refresh data
      App.addListener('appStateChange', ({ isActive }) => {
        if (isActive) {
          console.log('[Native] App resumed — refreshing data');
          // Refresh orders if the function exists
          if (typeof loadOrders === 'function') loadOrders();
        }
      });

      // Handle deep links (e.g., familylaundry://order/123)
      App.addListener('appUrlOpen', (event) => {
        console.log('[Native] Deep link:', event.url);
        // Parse the URL and navigate accordingly
        const url = new URL(event.url);
        if (url.pathname.startsWith('/order/')) {
          const orderId = url.pathname.replace('/order/', '');
          if (typeof showScreen === 'function') showScreen('orders');
        }
      });

      // Handle Android back button
      App.addListener('backButton', () => {
        // If on a sub-screen, go back. If on home, minimize app.
        const activeScreen = document.querySelector('.screen.active');
        if (activeScreen && activeScreen.id !== 'screen-home') {
          if (typeof showScreen === 'function') showScreen('home');
        } else {
          App.minimizeApp();
        }
      });

    } catch (e) { /* plugin not available */ }

    console.log('[Native] Bridge initialized ✅');
  });

} else {
  console.log('[Web] Running in browser — native bridge skipped');
}
