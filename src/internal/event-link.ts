/**
 * An event's private link back to the configuration that delivered it, so the
 * pretty logger needs no configuration passed in. It is held in a WeakMap rather
 * than on the event, so it cannot appear in a log or a JSON dump of an event.
 */

import type { Event, EventDataLevel } from "../events.js";
import type { Token } from "../highlight/kinds.js";

/** What the pretty logger needs from the configuration that delivered an event. */
export interface EventLink {
  /** What resource data the configuration's events carry. */
  readonly eventData: EventDataLevel;
  /** A saved record as labelled text, allowed during an operation. */
  savedEntityTokens(record: Uint8Array): Promise<Token[]>;
}

const links = new WeakMap<Event, EventLink>();

/** Remembers the configuration delivering `event`. */
export function linkEvent(event: Event, link: EventLink): void {
  links.set(event, link);
}

/** The configuration that delivered `event`, or undefined for one built by hand. */
export function eventLink(event: Event): EventLink | undefined {
  return links.get(event);
}
