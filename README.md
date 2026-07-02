# FantasyHockey

This project was generated using [Angular CLI](https://github.com/angular/angular-cli) version 22.0.5.

# 🏒 Cycle Hockey

A modern fantasy hockey web application built with Angular and Firebase that reimagines traditional fantasy hockey by replacing weekly matchups with an **6-Game Cycle System**.

The goal of this project is to create a fairer, more engaging fantasy hockey experience while serving as a full-stack portfolio project demonstrating modern web development techniques.

---

# Tech Stack

- Angular 22
- TypeScript
- Firebase Authentication
- Cloud Firestore
- Firebase Hosting (planned)
- NHL Public API (planned)

---

# Vision

Most fantasy hockey leagues use weekly matchups.

The problem is that NHL scheduling is uneven.

One fantasy team may play:

- 2 games

while another plays:

- 5 games

during the same matchup.

This project solves that problem.

Instead of weekly matchups, every matchup lasts until every rostered player has completed **8 NHL games**.

Once a player completes their eighth game:

- future games immediately begin counting toward the next matchup cycle.

This creates a much fairer fantasy experience.

---

# Core Features

## User Accounts

- Register
- Login
- Logout
- Persistent authentication

---

## League System

- Create leagues
- Join leagues using invite codes
- Commissioner controls
- Custom scoring rules

---

## Fantasy Teams

Each user owns one fantasy team per league.

Teams will include:

- Starting lineup
- Bench
- Waiver wire
- Trades
- Transaction history

---

## 8-Game Matchup System

Traditional fantasy hockey:

Week 1

Player A
4 games

Player B
2 games

Result:
Not equal.

Fantasy Hockey App:

Cycle 1

Every player contributes exactly 8 NHL games.

No scheduling advantage.

---

# Scoring Philosophy

This project intentionally uses larger fantasy point values than most platforms.

Large scores create:

- exciting player performances
- meaningful live updates
- satisfying fantasy totals

However, scoring is carefully balanced so that elite NHL players consistently outperform depth players over a season.

Goals and assists remain the primary source of fantasy points, while secondary statistics ensure role players still provide value.

Examples include:

- Shots
- Hits
- Blocked shots
- Plus / Minus

Defensemen receive additional balancing to better reflect their overall on-ice impact.

---

# Example Scoring

Goal ..................... +12

Primary Assist ........... +8

Secondary Assist ......... +5

Shot on Goal ............. +1

Hit ...................... +0.75

Blocked Shot ............. +1.25

Plus ..................... +2

Minus .................... -2

Power Play Point ......... +2

Short-Handed Point ....... +3

Game Winning Goal ........ +3

Defenseman Cycle Bonus ... +8

2 Goal Game Bonus ........ +4

Hat Trick Bonus .......... +8

---

# Planned Features

## League Management

- Invite Codes
- Commissioner Dashboard
- League Settings

## Draft

- Snake Draft
- Draft Timer
- Draft Board

## Players

- NHL Player Search
- Player Profiles
- Live Statistics
- Injury Status

## Live Matchups

- Live fantasy scoring
- Game notifications
- Win probability
- Projected cycle score

## Team Management

- Waivers
- Trades
- Lineup changes
- Team history

## Statistics

- League records
- Season leaders
- Trophy room
- Hall of Fame

---

# Current Progress

- [x] Angular project created
- [x] Firebase connected
- [x] Firestore connected
- [x] Authentication
- [x] User profiles
- [x] Dashboard
- [x] League creation
- [x] League detail page

- [ ] Join league
- [ ] Fantasy teams
- [ ] NHL API integration
- [ ] Player database
- [ ] Draft
- [ ] Scoring engine
- [ ] Matchup cycles
- [ ] Playoffs

---

# Future Improvements

- Mobile responsive UI
- Dark mode
- Commissioner analytics
- Trade review system
- Custom scoring editor
- Push notifications

---

# Purpose

This application is being developed as both a personal project and a portfolio piece to demonstrate:

- Angular
- TypeScript
- Firebase
- Authentication
- Cloud databases
- API integration
- Software architecture
- Real-time data processing

while building a fantasy hockey platform that friends can use throughout the NHL season.