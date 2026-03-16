# Star TSP654II — CloudPRNT Setup Guide
*WashRoute · One-time setup · ~10 minutes*

---

## What you need
- TSP654II connected to your WiFi network
- The printer's IP address (print a test page — it'll be on there)
- Admin access to washroute.vercel.app

---

## Step 1 — Find the printer's IP address

Power on the printer and hold the Feed button while powering on to print a self-test page.
The IP address will be printed near the top (e.g. `192.168.1.42`).

---

## Step 2 — Open the printer's web interface

On a device connected to the **same WiFi network** as the printer, open a browser and go to:

```
http://192.168.1.42
```
(replace with your actual IP)

Default login if prompted: **admin / admin**

---

## Step 3 — Configure CloudPRNT

In the printer's web UI, navigate to:
**StarWebPRNT** or **CloudPRNT** settings (exact menu name varies by firmware version)

Set the following:
| Field | Value |
|---|---|
| **Server URL** | `https://umjpbuxrdydwejqtensq.supabase.co/functions/v1/cloudprnt` |
| **Token** | Leave as default (MAC address) — you'll copy this in Step 4 |
| **Polling interval** | 5 seconds (default is fine) |
| **Enable** | ✅ On |

Save / Apply settings. The printer may restart.

---

## Step 4 — Connect the printer to WashRoute

1. Go to **washroute.vercel.app** → Admin login
2. Navigate to **Settings** (bottom of left sidebar)
3. Scroll to **🖨 Receipt Printer**
4. The **CloudPRNT Server URL** is already shown — it's pre-filled (just for reference)
5. In the **Printer Token** field, enter the token from Step 3 (e.g. `00-11-62-0D-B1-B8`)
6. Click **Save**
7. Click **🖨 Test Print**

The printer should pick up the test job within a few seconds and print a test receipt.

---

## Step 5 — Verify it works end-to-end

1. Go to **Orders** in the admin dashboard
2. Open any order → click **🖨 Print** in the bottom action bar
3. You should see a "✓ Sent to printer" toast — and the receipt prints automatically

That's it. No pop-ups, no tapping "Print" on a dialog. It just prints.

---

## Troubleshooting

**Printer not picking up jobs:**
- Confirm the printer's web UI shows CloudPRNT as enabled and the URL is correct
- Check the printer is on the same internet-connected WiFi (not a captive portal / guest network)
- Make sure the token in WashRoute Settings exactly matches what's in the printer's web UI

**"Failed to queue print job" toast:**
- You may not be logged in as an admin — log out and back in
- Check browser console for the specific error message

**Wrong output / garbled text:**
- Confirm firmware is up to date (Star Micronics website → Support → TSP654II)
- The printer expects UTF-8 Star Document Markup — don't use any other driver mode

---

*Setup instructions saved by WashRoute Admin — Mar 16, 2026*
