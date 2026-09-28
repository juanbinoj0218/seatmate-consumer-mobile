# SeatMate (iPhone app)

Live seat availability for cafés and restaurants. Customers search places,
see how many seats are free right now, and view each place's live floor plan.

Uses the same Firebase project as the SeatMate websites
(`juanbinoj0218/SeatMate`), so accounts and saved places are shared.

## Run it

```bash
npm install
npx expo start
```

Scan the QR code with the Camera app to open it in Expo Go.

Firebase settings go in `.env.local` (not committed):

```
EXPO_PUBLIC_FIREBASE_API_KEY=...
EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN=...
EXPO_PUBLIC_FIREBASE_PROJECT_ID=...
EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET=...
EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=...
EXPO_PUBLIC_FIREBASE_APP_ID=...
```

## Screens

- `src/app/index.tsx`: home (search, group size, filters)
- `src/app/place/[slug].tsx`: a place's live seats and floor plan
- `src/app/login.tsx`: sign in / create account
- `src/app/account.tsx`: saved places, recently viewed, profile, delete account

## Seat notifications ("Notify me when a seat opens")

**Currently switched off** (`SEAT_ALERTS_ENABLED` in `src/lib/features.ts`).
Turn it on after the function below is deployed.

The app saves what you're waiting for on `users/{uid}`, and a Firebase Cloud
Function (`functions/index.js`) sends the notification when staff mark a seat
open, even if the app is closed.

One-time setup:

1. Link the app to Expo (gives it a project ID for notifications):
   `npx eas-cli@latest init`
2. Switch Firebase to the Blaze (pay-as-you-go) plan. At SeatMate's size this
   stays within the free allowance.
3. Deploy the function (use the project ID from `.env.local`):
   `npx firebase-tools@latest deploy --only functions --project YOUR_PROJECT_ID`

Notifications work in Expo Go on iPhone. Android needs a development build.
