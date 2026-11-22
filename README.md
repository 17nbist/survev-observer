# survev observer

A Tampermonkey script that records what your survev.io game already shows you while you play, and sends it to the
[clip jury](https://clip-jury.pages.dev/), a side project that looks for players whose aim looks inhuman.

It only reads. No aim help, no wallhack, no automation: nothing in your game changes.

## Install

Step by step with pictures: [guide/GUIDE.md](guide/GUIDE.md).

1. Install [Tampermonkey](https://www.tampermonkey.net/) in your browser.
2. Chrome and Edge: on Tampermonkey's extension details page, switch on **Allow User Scripts**. Without it the script installs but never runs.
3. Open [survev-observer.user.js](https://raw.githubusercontent.com/17nbist/survev-observer/main/survev-observer.user.js). Tampermonkey shows the code and an Install button.
4. Play survev.io as normal. A small "observer" label in the bottom left corner shows it is on. Click it to pause.

## Death replay (the killcam, from 1.4.0)

When you die, a "Death replay" button appears (under Play Again, at the top of the spectate menu, or above the label). It opens
survev.io in a new tab and plays your last 20 seconds back through the game's own client: your screen exactly as you saw it, your
HUD, the doors, the kill feed, drawn by the game itself. The bar at the top pauses it, changes the speed (0.25x to 2x) and starts it
again. Save video records it with its sound and downloads a video file.

How: the script keeps a copy of what the server sends your game (about 3 KB a second, in that tab only, never uploaded). The replay
tab's game plays that copy instead of joining a server, so it sends nothing anywhere. Player names are in the copy, since the
server sends them to everyone; they stay in your browser.

The idea comes from [Surviv.io input replay recorder](https://greasyfork.org/scripts/447501) by garlic, samer kizi and preacher
(MIT), which records the game's socket the same way.

Without a copy (you installed or turned on the script after the match started), the button opens the
[clip jury](https://clip-jury.pages.dev/)'s map replay instead, made from the script's notes of the last minute: everyone your game
could see, the player who killed you ringed, and "Save video".

It is one file of about 500 lines. Read it before you install it.

## What it sends

Every 10 seconds, zipped, to `https://survev-observer.pages.dev/api/upload`:

- the map and its buildings (once a match)
- every game update: position, facing, weapon and gear of you and of the players on your screen; for you (or the player you watch after you die) also the scope and how far it lets you see
- bullets when they appear, kills from the kill feed, explosions, emotes and map pings, obstacles (once, then when they break or a door
  opens), smoke
- who you spectate after you die

- only if you are signed in to a survev.io account: the game's id (see below)

Players are the game's own numbers, never names. Nothing else about you leaves your browser beyond what is in the game: no account
name, no cookies, no browser details. The upload server keeps a random id for your browser (so one batch can be matched to the
next) and a scrambled, daily-changing version of your IP address, only to stop spam. Your IP address itself is not stored.

## The game id (signed-in players only, from 1.3.5)

A report to survev's moderators has to name the game, and the game does not tell its client that id. The game's own stats site
does: your match history (the list on your stats page) shows your games with their ids once a game is over.

So if, and only if, the game says you are signed in:

- when a match ends, the script keeps a small note in your browser (which match, when it started, how long you lived, your
  in-game number; no names);
- from the menu it asks survev.io's stats server (api.survev.io) for your match history, as your stats page does (one request, at
  most six tries a match, from 30 seconds to 40 minutes after it: a game can go on long after you die), and finds the row of
  that match by how long you lived (a win: by the game's end);
- it sends one line: the match's start, the game id, your in-game number.

What that means for you: your account's name goes to survev.io only (it is their site and your own history) and is never sent to
us. But the game id points at that game's public stats page, which lists every player of the game by name, you included, and
your in-game number says which row is yours. So with the game id we can see which account recorded the match. We use it for one
thing: when a player in one of your matches is flagged as a likely cheater, a moderator can be given the game and that player's
name. If you do not want that, sign out of survev.io or pause the script (click the label): not signed in, none of this runs.

## How it works

`survev-observer.user.js`, top to bottom:

1. It waits for the game to start and keeps a reference to it. The game's main object passes through `Function.prototype.call` once while it loads; the script spots it there and puts `Function.prototype.call` back.
2. The game renames its fields when it is built, so the script finds what it needs by shape (a list of players, an object with four position fields, and so on) and remembers the names.
3. On each world update from the server, it writes one line of numbers. Every 10 seconds it zips the lines and sends them.
4. It keeps a copy of the game socket's messages for the killcam (part 0 of the file); it never sends that copy.

`server/` is the upload endpoint (Cloudflare Pages Functions and a D1 table). Batches stay there until they are pulled into the
clip jury's data, then they are deleted.

## License

MIT
