# survev observer

A Tampermonkey script that records what your survev.io game already shows you while you play, and sends it to the
[clip jury](https://clip-jury.pages.dev/), a side project that looks for players whose aim looks inhuman.

It only reads. No aim help, no wallhack, no automation: nothing in your game changes.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) in your browser.
2. Open [survev-observer.user.js](https://raw.githubusercontent.com/17nbist/survev-observer/main/survev-observer.user.js). Tampermonkey shows the code and an Install button.
3. Play survev.io as normal. A small "observer" label in the bottom left corner shows it is on. Click it to pause.

It is one file of about 200 lines. Read it before you install it.

## What it sends

Every 10 seconds, zipped, to `https://survev-observer.pages.dev/api/upload`:

- the map and its buildings (once a match)
- every game update: position, facing, weapon and gear of you and of the players on your screen
- bullets when they appear, kills from the kill feed, explosions, emotes and map pings, obstacles (once, then when they break or a door
  opens), smoke
- who you spectate after you die

Players are the game's own numbers, never names. Nothing about you leaves your browser beyond what is in the game: no account,
no name, no cookies, no browser details. The upload server keeps a random id for your browser (so one batch can be matched to the
next) and a scrambled, daily-changing version of your IP address, only to stop spam. Your IP address itself is not stored.

## How it works

`survev-observer.user.js`, top to bottom:

1. It waits for the game to start and keeps a reference to it. The game's main object passes through `Function.prototype.call` once while it loads; the script spots it there and puts `Function.prototype.call` back.
2. The game renames its fields when it is built, so the script finds what it needs by shape (a list of players, an object with four position fields, and so on) and remembers the names.
3. On each world update from the server, it writes one line of numbers. Every 10 seconds it zips the lines and sends them.

`server/` is the upload endpoint (Cloudflare Pages Functions and a D1 table). Batches stay there until they are pulled into the
clip jury's data, then they are deleted.

## License

MIT
