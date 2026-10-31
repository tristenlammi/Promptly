/* Tiny in-module signals between tabs: "open this booking" when jumping
 * from the itinerary to Bookings, and the header's quick "Add expense". */

let focusBooking: string | null = null;
let focusDay: string | null = null;

export function requestBooking(id: string) {
  focusBooking = id;
}
export function takeBooking(): string | null {
  const v = focusBooking;
  focusBooking = null;
  return v;
}
export function requestDay(day: string) {
  focusDay = day;
}
export function takeDay(): string | null {
  const v = focusDay;
  focusDay = null;
  return v;
}

/* The header's "Add expense": the shell switches to the Money tab
 * (``nav.goTo``) and Money opens its sheet — on mount, or right away when
 * it's already showing. */
let addExpense = false;
const listeners = new Set<() => void>();
export function requestAddExpense() {
  addExpense = true;
  listeners.forEach((f) => f());
}
export function takeAddExpense(): boolean {
  const v = addExpense;
  addExpense = false;
  return v;
}
export function onAddExpense(f: () => void): () => void {
  listeners.add(f);
  return () => void listeners.delete(f);
}
export function addExpensePending(): boolean {
  return addExpense;
}

/* "New trip" from the header (no trips yet) or anywhere: the trips home
 * opens its sheet — on mount, or right away when it's showing. */
let newTrip = false;
const newTripListeners = new Set<() => void>();
export function requestNewTrip() {
  newTrip = true;
  newTripListeners.forEach((f) => f());
}
export function takeNewTrip(): boolean {
  const v = newTrip;
  newTrip = false;
  return v;
}
export function onNewTrip(f: () => void): () => void {
  newTripListeners.add(f);
  return () => void newTripListeners.delete(f);
}
