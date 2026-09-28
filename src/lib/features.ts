// On/off switches for features that aren't ready to use yet.

// "Notify me when a seat opens" (whole place and specific seats).
// The code is all in place, but the notifications need the Cloud Function in
// functions/ deployed, which needs Firebase's Blaze plan with active billing.
// Once that's deployed, change this to true.
export const SEAT_ALERTS_ENABLED = false;
