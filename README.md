# Tindahan Manager (local network version)

One computer in the store runs the server. Every phone, tablet or laptop connected
to the same router opens it in a browser. No internet is needed after Node.js is installed.

## Set up (Windows)

1. Install **Node.js LTS** from https://nodejs.org (one-time, needs internet).
2. Unzip this folder anywhere, for example `C:\Tindahan`.
3. Double-click **start.bat**. A black window opens and shows:

       On phones (same Wi-Fi): http://192.168.1.15:3000

4. If Windows asks about the firewall, tick **Private networks** and choose **Allow**.
5. On any phone connected to the same Wi-Fi, open that address in the browser.
   Tip: in Chrome tap ⋮ > *Add to Home screen*; on iPhone use Share > *Add to Home Screen*.

Keep the black window open. Closing it stops the system.

Mac / Linux / Android (Termux): run `node server.js` in this folder.

## First login

| Username | Password  | Role          |
|----------|-----------|---------------|
| admin    | admin123  | Administrator |
| staff    | staff123  | Staff         |

Each account must change its password on first sign-in. The owner can add more staff
under **Account > Manage users**. On an empty store, the owner can tap
**Load sample products** to try things out.

## What each role can do

- **Administrator:** everything: products, prices, stock adjustments, categories, users, all reports, backups.
- **Staff:** search products, view prices, stock in and stock out, view stock and the Products / Low stock reports. Staff never see cost prices.

## Keep the address from changing

Routers can hand out a different address after a restart. In the router's admin page
(usually http://192.168.1.1), find the DHCP settings and **reserve** this computer's address,
so phones and home-screen shortcuts keep working.

## Your data

- Everything is saved in `data/store.json`.
- A copy is saved automatically each day in `data/backups/` (last 14 days kept).
- The owner can also tap **Account > Download backup** on a phone.
- To restore: stop the server, replace `data/store.json` with a backup file, start again.
- Copy the `data` folder to a USB drive now and then.

## Change the port or start on boot

- Different port: `set PORT=8080` then `node server.js` (Windows), or `PORT=8080 node server.js`.
- Start when the computer turns on: put a shortcut to `start.bat` in the Startup folder (press Win+R, type `shell:startup`).

## Security notes

This is designed for a trusted home or store Wi-Fi. It uses plain HTTP, so do not expose it to the internet
(no port forwarding). Passwords are stored hashed. Use a strong Wi-Fi password, and do not let customers
onto the same network.
