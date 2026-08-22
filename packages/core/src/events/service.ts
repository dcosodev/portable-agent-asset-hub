import type { Event, EventCreate } from './types.js';
export interface EventRepository { create(input: EventCreate): Event; get(id:string, scope:Event['scope']): Event|undefined; }
