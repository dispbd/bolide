// Vue's DOM renderer looks for `document` when it loads, so this module is imported first.
import { Window } from 'happy-dom'

export const window = new Window()
Object.assign(globalThis, { window, document: window.document, SVGElement: window.SVGElement, Element: window.Element })
