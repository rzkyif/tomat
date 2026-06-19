---
title: Installing tomat
section: Getting Started
order: 1
demo: install
---

tomat runs as two parts: a **core** (a local service that does the work) and a
**client** (the app you look at). The installer below sets up both on your
machine, so everything stays local by default.

## Install

Pick your operating system above and copy the one-line command into a terminal.
It downloads the client, which fetches and supervises a core for you on first
launch.

## What gets installed

- The **tomat client**, the desktop app.
- A **core** the client pairs with, kept under `~/.tomat`.

Nothing leaves your machine unless you point a setting at an external provider.

## Updating

tomat updates itself: when a new release is available the app offers to install
it. You can also re-run the install command at any time to get the latest build.
