# AppointmentDock

Multi-tenant online booking for local businesses (barbers, salons, spas, studios…).
One deployment serves many businesses, each with its own booking page at `/b/<link>`.

## What it does

- **Customers**: pick one or more services, a specific staff member or "anyone available",
  then a day and time. Get a confirmation with a view/cancel link. Optional account to see all bookings
  (email must be confirmed first).
- **Business owners**: services (duration, cleanup buffer, price, category), staff (which services
  each offers, weekly split shifts, time off), appointments (day/week view, manual booking with optional
  hours override, move, complete, no-show, cancel), customers, booking rules, notification settings,
  message log. Invite staff by link.
- **Staff**: own appointments, own hours and time off.
- **Platform admin** (you): create businesses, invite owners, jump into any business.
- **Notifications**: email via Resend, SMS via Twilio. Confirmations, cancellations and reminders
  (default 24h before). Without credentials they're logged as "skipped".

Not built yet: Google Calendar sync, online payments/deposits, recurring appointments, waitlist.

## Stack

Node 22, no npm dependencies. SQLite via the built-in `node:sqlite`. Vanilla JS front end.

```
npm run dev     # http://localhost:8080 with a demo business, admin@example.com / devpassword123
npm test
```

## Configuration (environment)

| Variable | Purpose |
| --- | --- |
| `APP_PATH` | Base path when served under a sub-path, e.g. `/appointmentdock` |
| `APP_URL` | Public URL including the base path (used in emails and links) |
| `DATA_DIR` | Where the SQLite database lives |
| `PLATFORM_ADMIN_EMAIL` | Platform admin login (created on start) |
| `SETUP_TOKEN` | One-time token; open `<APP_URL>/setup?token=…` to set the admin password |
| `SEED_DEMO` | `true` adds the demo barbershop at `/b/demo` |
| `RESEND_API_KEY`, `EMAIL_FROM` | Email sending |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_SERVICE_SID` or `TWILIO_FROM` | SMS sending |
| `COOKIE_SECURE` | `true` behind HTTPS |

## Deploying on the Hostinger VPS

`deploy/docker-compose.yml` builds the image straight from this GitHub repo and routes
`https://<APP_DOMAIN>/appointmentdock` through the existing Traefik (`root_default` network,
`mytlschallenge` resolver). Create it as the `appointmentdock` project in the VPS Docker manager with
the environment variables above plus `APP_DOMAIN`. To ship changes: push to `main`, then rebuild the project.

`deploy/make-compose.sh` is an alternative that embeds the app in the compose file itself (no git access needed).
