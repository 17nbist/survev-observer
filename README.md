# survev observer

A Tampermonkey script that records what your survev.io game already shows you while you play, and sends it to the
[clip jury](https://clip-jury.pages.dev/), a side project that looks for players whose aim looks inhuman. From 1.8.0 it also sends a
copy of what the game's server sent your game, so a moment you flag can be shown on the jury in the game's own client (see **The
match copy** below).

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
HUD, the doors, the kill feed, drawn by the game itself.

From 1.8.0 the first open no longer says "failed joining game": the new tab opens at `survev.io/?vbkc=1`, which joins nothing, and the script starts the replay itself once it is running (it reloads that tab once by itself if the userscript manager came in late). 1.8.0 also keeps each uploaded chunk of the match copy exactly as first built until it is taken, and uploads the last one when the game closes or you die, so nothing is lost on a bad connection or a closed tab.

The replay plays as soon as it opens. The bar at the top:

- pause and play, 5 s back or on, back to the start, and a slider to go anywhere in the 20 s; going back
  takes about a second and never reloads the tab
- **Death**: straight to the 4 s before your death; **Loop** plays those 4 s and the 2 after again and again
- speed 0.25x to 2x
- **Download** (from 1.7.0): at any moment, whatever you are watching, one click makes the whole replay as an MP4 and saves it.
  It does not play the replay in real time: the script draws the game frame by frame as fast as your computer can (about 5 seconds
  for a 20 s replay), with its HUD and its sound, then puts the replay back where you were. The file is sized to stay under
  Discord's 10 MB. A browser that cannot do that (no WebCodecs) records the replay in real time instead; the button then says so.

How: the script keeps a copy of what the server sends your game (about 3 KB a second). The replay tab's game plays that copy
instead of joining a server, so it sends nothing anywhere. Player names are in the copy, since the server sends them to everyone.
From 1.8.0 the copy is also uploaded (see **The match copy** below); the replay itself is still played from your browser's own copy.

The idea comes from [Surviv.io input replay recorder](https://greasyfork.org/scripts/447501) by garlic, samer kizi and preacher
(MIT), which records the game's socket the same way.

Without a copy (you installed or turned on the script after the match started), the button opens the
[clip jury](https://clip-jury.pages.dev/)'s map replay instead, made from the script's notes of the last minute: everyone your game
could see, the player who killed you ringed, and "Save video".

## Save a clip (from 1.6.0)

Saw something that looked like a cheater? Press your clip key: the script keeps the 20 seconds before the press and the 10 seconds
after it, to watch the same way as a death replay (Download included). You hear a short beep; press again while it is still saving and
the clip goes on to 10 seconds after that press (two beeps), up to 60 seconds in all. A low tone says it is saved.

- **Pick the key**: there is none until you pick one. The menu shows an orange bar the first time (**Set key**, then press a key or
  a mouse side button), and survev's own **Settings > Keybinds** has a **Save clip (observer)** row to change it later (Esc cancels,
  Backspace removes it). A key the game already uses works too: you get a warning, and both happen.
- **Watch**: click **▶ N clips** next to the label in the bottom left corner at any time, or **Saved clips** on the results screen.
- 5 clips a match and the 10 newest in all are kept, in that tab only. Close the tab and they are gone; save a video to keep one.

The script only listens for that one key: your game gets it as before, and the script never presses, holds or changes any input.
The clip itself (the tab's copy) is not sent as a clip. What is sent is one small line per press, with the time and the clip's number
(see below), so the clip jury can look first at the moments players pointed at; the match copy (see below) is what lets the jury
show that moment in the game's own client.

It is one file of about 1000 lines. Read it before you install it. From 1.7.0 it also loads one library, mp4-muxer 5.2.2 (MIT, the
part that packs the Download into an MP4 file): Tampermonkey fetches it from cdn.jsdelivr.net when you install or update the script,
at that exact version, never while you play. It is loaded with the script but used only when you press Download. If it cannot load,
Download records in real time instead.

## What it sends

Zipped, to `https://survev-observer.pages.dev/api/upload`, every 10 seconds but never while you are alive in a match (from 1.8.1):
what a match noted goes once you die or the match ends, so the upload never competes with your game. It is:

- the map and its buildings (once a match)
- every game update: position, facing, weapon and gear of you and of the players on your screen; for you (or the player you watch after you die) also the scope and how far it lets you see
- bullets when they appear, kills from the kill feed, explosions, emotes and map pings, obstacles (once, then when they break or a door
  opens), smoke
- who you spectate after you die
- when you press your clip key (from 1.6.0): the time of the press and the clip's number, nothing else

- only if you are signed in to a survev.io account: the game's id (see below)
- from 1.8.0, separately, to `https://survev-observer.pages.dev/api/wire`: the match copy (next section)

In these notes players are the game's own numbers, never names. Nothing else about you leaves your browser beyond what is in the game: no account
name, no cookies, no browser details. The upload server keeps a random id for your browser (so one batch can be matched to the
next) and a scrambled, daily-changing version of your IP address, only to stop spam. Your IP address itself is not stored.

## The match copy (from 1.8.0)

So that a clip of a moment can be shown on the clip jury in the game's own, unmodified client (a video of the game playing back
exactly what your game was sent), the script uploads a copy of what the server sent your game during the match, the same copy the
death replay plays:

- **What it is**: the messages the game's server sends to your game, exactly as they arrived, with their times. About 3 KB a second,
  about 10 MB an hour, zipped, in chunks every 10 seconds once you are dead or the match is over (from 1.8.1), and when the game's socket closes, to
  `https://survev-observer.pages.dev/api/wire`. The first chunk of a match also says when the socket opened, the game server's host
  and port, the game's version (the `gitRevision` the page's own `site_info` answer reports, read as the page gets it) and the
  script's version.
- **What is not in it**: nothing you send. Your keys, mouse, chat, account, cookies and browser details are not in it, only what the
  server sends down.
- **Names are in it**: the server sends every player's name to every player, so the copy holds the names of the players of your game
  as the game shows them, yours included. (The track notes above still never carry names.)
- **Where it goes**: only to the observer's server, stored privately, deleted from the server once the clip jury has pulled it (anything
  older than 7 days is dropped in any case). It is never published as it is; what the jury shows is a video of a moment, not the file.
- **Pause**: clicking the label pauses it; nothing is uploaded while paused, and a match that was paused is not picked up again.
- If a chunk cannot be sent for good, the rest of that match's copy is not sent either (a gap makes the later chunks unreadable);
  your game is not affected.

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
3. On each world update from the server, it writes one line of numbers. Once you die or the match ends it zips the lines and sends them, in batches 10 seconds apart (1.8.1; before, every 10 seconds while you played).
4. It keeps a copy of the game socket's messages for the killcam (part 0 of the file), and sends it to the observer's server in
   chunks (part 3b), so a clip can be shown in the game's own client on the clip jury. It also reads the page's own
   `/api/site_info` answer for the game's version (a copy of the response; the page's request is unchanged).
5. Your clip key (part 5) cuts a clip out of that same copy; it listens for that key only, and holds a press back only while you
   are picking the key.

`server/` is the upload endpoint (Cloudflare Pages Functions and a D1 database): `/api/upload` for the notes and `/api/wire` for the
match copy. Batches and chunks stay there until they are pulled into the clip jury's data, then they are deleted.

## License

MIT
