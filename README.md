# Prolific Notifier to Telegram

Monitors Prolific studies every 5 minutes and sends new-study alerts to a Telegram chat.

## Features

- Login and automatic re-login using Prolific credentials from environment variables.
- Polling loop every 5 minutes (configurable).
- Detects new studies and sends Telegram notifications with study details.
- Stores already-notified study IDs in SQLite to avoid duplicates after restarts.
- Detects captcha/security challenge and enters safe pause mode.
- Sends Telegram alert when blocked/captcha is detected.

## Study Fields Sent to Telegram

- Name
- Reward
- Estimated time
- Places available
- Places taken
- Total places
- Study ID
- Direct link

## Local Run

1. Install dependencies:

```bash
npm install
```

2. Create environment file:

```bash
cp .env.example .env
```

3. Build and run:

```bash
npm run build
npm start
```

For development:

```bash
npm run dev
```

## Railway Deployment

1. Push this repository to GitHub.
2. Create a Railway project and connect the repository.
3. Ensure Dockerfile deploy is used (railway.toml is included).
4. Add all environment variables from .env.example in Railway Variables.
5. Add a persistent volume and mount it so DATABASE_PATH and SESSION_STATE_PATH survive restarts.

Recommended persistent paths:

- DATABASE_PATH=/app/data/prolific.db
- SESSION_STATE_PATH=/app/data/prolific-session.json

## Important Notes

- This implementation does not try to bypass anti-bot or captcha systems.
- If captcha/challenge is detected, worker pauses and sends Telegram alert.
- Manual intervention is required, then restart the service.
- Prolific UI selectors can change over time; adjust parser selectors if needed.

## Manual Intervention (When Worker Is Paused)

Railway cannot show an interactive browser window, so manual login must be done locally.

1. Pull the latest code locally.
2. Set your local .env with PROLIFIC_EMAIL and PROLIFIC_PASSWORD.
3. Run the manual bootstrap command:

```bash
npm run manual-session
```

4. A real browser opens. Complete login manually and solve any captcha/challenge.
5. Return to terminal and press Enter.
6. The script saves SESSION_STATE_PATH and prints SESSION_STATE_BASE64.
7. Copy that base64 string into Railway Variables as SESSION_STATE_BASE64.
8. Redeploy or restart service in Railway.

At startup, the service hydrates the session file from SESSION_STATE_BASE64 before creating the browser context.
