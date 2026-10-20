# Purpose and authority

Build a single human versus AI Mafia game with a neutral, server controlled moderator. The human plays alongside eleven AI personas inspired by founders and investors. Personas shape dialogue and decisions; the game engine alone assigns roles, validates actions, resolves outcomes, and declares victory.

This specification records the gameplay agreed in our conversation. The [Founders Fund Mafia episode](https://www.youtube.com/watch?v=EDCwQe7P8T0) is the inspiration; our agreed rules take precedence wherever they differ.

Status: implementation draft, version 1, 20 October 2026. Rules described below are mandatory unless explicitly marked as proposed implementation defaults. Defaults make this draft implementable but are not additional decisions already approved by the user.

# Players roles and victory

There are exactly twelve seats: one human and eleven AI players. Each seat has a stable player ID, display persona, and seat number. The moderator is not a player.

| Role | Count | Team | Ability |
| - | -: | - | - |
| Mafia | 3 | Mafia | Coordinate one attempted night kill |
| Angel | 1 | Town | Protect one living player each night |
| Sheriff | 1 | Town | Learn the exact role of one other living player each night |
| Townsperson | 7 | Town | Discuss, nominate, and vote |

Assign roles randomly once at game creation, without replacement, independently of persona. Roles never change. If cards appear in the frontend, Jack means Mafia, Ace means Angel, King means Sheriff, and ordinary cards mean Townsperson.

Each player knows their own role. Mafia additionally know their teammates. Other players do not know anyone else's role unless the Sheriff has privately investigated them, or the human has entered spectator mode.

Town wins when no Mafia remain alive. Mafia wins when living Mafia are greater than or equal to all living Town members combined, including Angel and Sheriff. Check victory after the dawn outcome and each daytime elimination, before opening another playable phase. Team victory includes eliminated team members. End the game immediately once a victory condition holds.

# Complete game cycle

The game begins with Night 1. Night 1 leads to Day 1, then Night 2, and so on. A round contains one night followed by its day.

| Order | Phase | Participants and result |
| - | - | - |
| 1 | Mafia coordination | Living Mafia point at a target without words |
| 2 | Angel protection | Living Angel privately chooses a protection target |
| 3 | Sheriff investigation | Living Sheriff privately investigates a target |
| 4 | Dawn resolution | Resolve protection and attempted kill; announce death or no death; check victory |
| 5 | Public discussion | Living players discuss for approximately 60 seconds |
| 6 | Secret nominations | Each living player nominates two different living players |
| 7 | Nominee selection | Two highest nomination totals advance; resolve cutoff ties randomly |
| 8 | First defense | First nominee speaks uninterrupted for 15 seconds |
| 9 | Second defense | Second nominee speaks uninterrupted for 15 seconds |
| 10 | Public elimination vote | Every living player votes for one of the two nominees |
| 11 | Additional defenses if tied | Both nominees receive another defense |
| 12 | Second public vote if tied | Vote again; a second tie is resolved randomly |
| 13 | Day elimination | Eliminate the selected nominee without revealing their role; check victory |

If the game continues, increment the round and open the next Mafia coordination phase. No nominations, votes, or dialogue carry over as pending actions; public conversation history and private knowledge persist.

# Night rules

## Mafia coordination

Mafia coordination permits actions only. A living Mafia member can point at a target, observe teammates' current pointers, and change their own pointer. There is no spoken conversation, written chat, free text, gesture caption, or shared explanation during this phase.

The engine records two separate things:

- Each living Mafia member's current target.

- The target of the first valid pointer accepted that night, which is an immutable fallback.

At the end of coordination, if every living Mafia member currently points at the same target, that target is selected. Otherwise, select the original first target. Changing a pointer does not change the recorded fallback. This is a disagreement fallback, not an immediate lock when the first pointer arrives.

For example, A points at X first, then A changes to Y. If A, B, and C finish pointing at Y, choose Y. If they finish split between Y and Z, choose X.

A single surviving Mafia member chooses alone; their current pointer is unanimous. The fallback resets every night.

Proposed defaults: only living non Mafia players are valid targets; coordination lasts 20 seconds and resolves at its deadline, even if temporary unanimity happens earlier. The server's serialized acceptance order determines the first pointer, never client timestamps or display order. If no valid pointer exists, pause for recovery instead of inventing a victim.

## Angel protection

The Angel privately selects one living player and may select themself. The Angel cannot protect the same player on consecutive nights. They do not see the Mafia's selected target.

Protection prevents that night's Mafia kill only. It does not protect against daytime elimination. Neither the Angel's identity nor the protection target is publicly revealed.

Proposed defaults: protection is an optional action with a 30 second window. A skipped or expired choice means no protection that night. The consecutive night restriction compares against the immediately preceding night's accepted protection target; a skipped night breaks the sequence. Accepted choices are final for that night.

## Sheriff investigation

The Sheriff privately selects one other living player and learns their exact role: Mafia, Angel, or Townsperson. There is only one investigation per night. Reinvestigating a previous target is permitted.

The result is private knowledge, retained by the Sheriff. The Sheriff may later tell the truth, conceal it, or lie in public discussion. A public role claim is ordinary dialogue; the engine does not authenticate it or display a verified role badge.

Proposed defaults: investigation is optional with a 30 second window. An expired or skipped choice produces no result. A valid accepted choice returns its result privately immediately and cannot be changed.

## Dawn resolution

Resolve all night actions against the players alive at the beginning of the night. A Mafia target remains alive and can use their Angel or Sheriff ability until dawn. If the protection target matches the Mafia target, nobody dies. Otherwise, eliminate the Mafia target.

Announce only the eliminated player's identity, or that nobody died. Do not announce the victim's role, the attempted victim on a saved night, or who protected whom. Then check victory.

The resolve at dawn rule is an explicit implementation interpretation: choosing a victim does not itself eliminate them.

Keep Angel and Sheriff phase windows and public moderator prompts the same even when those roles are dead. Route private actions only to an eligible living role holder. A missing role must not be revealed through a skipped phase or shorter timer.

# Day rules

## Discussion

Living players may accuse, question, defend, bluff, and claim any role during approximately one minute of real time. Eliminated players cannot contribute. Private role cards and investigation records are never published by an engine action to prove a claim.

Proposed defaults: use exactly 60 seconds of server measured active play time. Messages must be accepted before the deadline; queued or late model responses are not published afterward. The backend accepts public text or a transcript of speech. Voice synthesis and animation do not change the clock or authority of a message. Speaker scheduling is a frontend and agent orchestration concern; it must not grant an extra minute to each player.

## Secret nominations

Every living player submits two distinct living player IDs. Each nominated player receives one point from that ballot. Nominations are private; surviving players see the selected nominees, not individual ballots or totals.

The two highest totals always advance. Resolve a tie only where it affects an available seat. Fill seats in descending total order; if a tied group is larger than the number of remaining seats, choose the needed number uniformly at random without replacement.

Examples: A has five nominations and B and C have three each: A advances, plus one random choice between B and C. A, B, and C tie for first: choose two of the three randomly.

Proposed defaults: self nomination is allowed, but the two names must differ. Ballots are final once accepted. Use a 30 second collection window and proceed earlier if every ballot is received. Missing ballots trigger the recovery policy; they are not silently treated as abstentions.

## Defenses

Each nominee receives 15 uninterrupted seconds. Only the active nominee can publish a defense during their slot. Other players cannot interrupt. Silence is allowed and does not extend the slot.

Proposed defaults: nominees speak in ascending seat number order. Each gets the same 15 second slot again if the first elimination vote ties.

## Elimination vote

Every living player, including both nominees, casts exactly one vote for one of the two nominees. Votes are public: all living players can see who voted for whom. The nominee with more votes is eliminated.

If the first vote ties, let both nominees defend again and conduct a second vote with the same nominees. Do not repeat nominations or open another general discussion. If the second vote also ties, select one of the two nominees uniformly at random for elimination.

Proposed defaults: self voting is allowed; accepted votes are final within that vote attempt. Publish each accepted vote immediately. Each attempt has a 30 second window and closes early when all votes arrive. Missing votes trigger recovery rather than random elimination or abstention. The second attempt starts with an empty ballot collection.

## Elimination and spectating

Daytime elimination reveals the eliminated player's identity but not their role. An eliminated player loses all speaking, nomination, voting, and night action rights immediately.

If the human is eliminated, switch them to a read only omniscient spectator view for the rest of the game: all roles, private actions, ballots, and investigation results are visible. They may watch but cannot influence surviving players. The AI continue receiving only their own permitted information.

Proposed default: spectator mode includes the full prior game record as well as future events. At game completion, reveal all roles and the complete gameplay record to the human. Full transparency means game information, not internal model reasoning, credentials, or operational logs.

# Implementation defaults to review

These choices fill gaps that were not explicitly settled in the conversation. They are versioned configuration for the initial implementation, not claims about the original video.

| Topic | Proposed version 1 behavior |
| - | - |
| Mafia timing | Fixed 20 second coordination; evaluate final pointers at deadline |
| Mafia targets | Living non Mafia players only |
| No Mafia pointer | Recovery pause; never generate an arbitrary victim |
| Angel and Sheriff timing | Fixed 30 second windows, including when the role is dead |
| Missing Angel or Sheriff choice | No action; explicit skip is also allowed |
| Consecutive protection | Compare with immediately previous night; skipping breaks the sequence |
| Night death timing | Everyone alive at night start can act before dawn |
| Nominations | Self nomination allowed; two distinct names; private immutable ballot |
| Nomination totals | Hidden from living players; only nominees announced |
| Defenses | Seat order; 15 seconds per nominee on both attempts |
| Public votes | Self voting allowed; immutable; reveal as each vote is accepted |
| Required ballot windows | 30 seconds; close early when complete; pause if incomplete |
| Infrastructure interruptions | Preserve state and pause; do not fabricate player decisions |
| Endgame and spectator history | Human can inspect all past gameplay secrets once eliminated or game ends |

All timer values must be stored in the game's configuration at creation, rather than changed silently during play. The 60 second discussion and initial 15 second defenses reflect the agreed format. Other durations are defaults above.

# Backend state and transition contract

Use a deterministic game engine: given the same initial state, ordered accepted commands, timer events, and recorded random outcomes, it must produce the same result. The engine does not ask an LLM who won or which rules apply.

## Minimum authoritative state

| Object | Required contents |
| - | - |
| Game | Game ID, rules version, immutable configuration, lifecycle status, round number, phase ID, phase type, deadline, state version |
| Players | Player ID, seat, persona ID, human or AI control, secret role, team, alive status, elimination round and cause |
| Night | Alive at start, current Mafia pointers, first accepted pointer target and sequence, selected kill target, protection choice, previous night's protection, investigation target and result |
| Day | Secret nomination ballots, totals, nominees, defense order, vote attempt, public vote ballots, selected elimination |
| Private knowledge | Each player's role knowledge and Sheriff investigation history |
| Outcome | Winning team, terminal reason, final event sequence |
| Audit | Ordered accepted events, command deduplication records, private random draw records |

Use lifecycle states CREATED, RUNNING, PAUSED, FINISHED, and ABANDONED. Abandonment is an operational exit, not a team victory. It is never automatic merely because a recovery timer expired.

Each phase instance has a unique ID, even for repeated defenses and second votes. Store the vote attempt separately as 1 or 2. A participant reconnecting to an earlier phase must not be able to submit a stale action.

Automatic transitions include nominee selection, dawn resolution, elimination, and victory checks. Persist each resolution and its resulting events atomically so a retry cannot eliminate two players or repeat a random draw.

The phase sequence is:

```text
MAFIA_COORDINATION -> ANGEL_PROTECTION -> SHERIFF_INVESTIGATION
-> DAWN_RESOLUTION -> WIN_CHECK
-> DISCUSSION -> NOMINATIONS -> NOMINEE_SELECTION
-> DEFENSE_1 -> DEFENSE_2 -> ELIMINATION_VOTE_1
   majority -> DAY_ELIMINATION
   tie -> REDEFENSE_1 -> REDEFENSE_2 -> ELIMINATION_VOTE_2
          majority -> DAY_ELIMINATION
          tie -> RANDOM_ELIMINATION_SELECTION -> DAY_ELIMINATION
-> WIN_CHECK -> next round MAFIA_COORDINATION

Any successful WIN_CHECK -> FINISHED
Operational recovery -> PAUSED -> same pending phase
```

# Commands events and visibility

## Player commands

Every command carries game_id, phase_id, command_id, action type, and payload. Derive actor identity from the authenticated session or trusted agent worker; do not trust a caller supplied player ID. The server stamps receipt order and acceptance time.

| Command | Payload | Allowed actor and phase |
| - | - | - |
| Point | target_player_id | Living Mafia during coordination; may repeat with a changed target |
| Protect | target_player_id | Living Angel during protection |
| Investigate | target_player_id | Living Sheriff during investigation |
| SkipAbility | none | Living Angel or Sheriff during their ability phase |
| Speak | text or validated speech transcript | Living player in discussion, or active nominee in defense |
| Nominate | two distinct target_player_ids | Any living player during nominations |
| Vote | nominee_player_id | Any living player during current elimination vote |

Spectator reads are queries, never player commands. Pause, resume, timer expiration, and phase advancement are system operations; players and models cannot advance phases directly.

Reject commands for wrong game, wrong phase, expired deadline, dead actor, wrong role, invalid target, invalid cardinality, duplicate final submission, or forbidden communication. A duplicate command ID with an identical payload returns the original result without applying it twice; reuse with a different payload is rejected.

Use server serialized acceptance order for simultaneous pointers and votes. Accept a timed action only before the active deadline. The first valid pointer means the first accepted legal command, not the first malformed request, model call, or browser animation. Do not expose another player's secret role in validation errors.

## Events and audience projections

Maintain an internal ordered event stream. Deliver explicitly filtered projections; never send full authoritative state to a client and rely on the UI to hide it.

| Information | Living Town player | Living Mafia | Eliminated human |
| - | - | - | - |
| Seats, alive status, phase, public dialogue | Yes | Yes | Yes |
| Own role | Yes | Yes | All roles |
| Mafia teammates and night pointers | No | Yes | Yes |
| Protection target | Angel only | No | Yes |
| Investigation result | Sheriff only | No | Yes |
| Individual nomination ballots | Own only | Own only | All |
| Public elimination ballots | Yes | Yes | Yes |
| Hidden role of eliminated player | No | Only if already known | Yes |

Previously acquired private knowledge remains available to its owner. A Mafia player still knows a dead teammate's role; a Sheriff still knows an investigated player's role after that player's death.

Useful internal event types include GameCreated, RolesAssigned, PhaseOpened, PointerAccepted, ProtectionSubmitted, InvestigationResolved, NominationSubmitted, NomineesSelected, SpeechPublished, VoteCast, RandomSelectionResolved, PlayerEliminated, DawnAnnounced, GamePaused, GameResumed, and GameFinished.

RolesAssigned must generate individual private views. PointerAccepted is visible to Mafia and spectators only. Protection and investigation events are visible only to their role holder and spectators. NominationSubmitted reveals ballot content only to its author and spectators. VoteCast is public. PlayerEliminated must omit role from ordinary public payloads.

Public phase messages must not identify the Angel or Sheriff or indicate whether either remains alive. Omit hidden information from ordinary analytics payloads and model context as well as frontend responses.

# AI player contract

Each AI is an ordinary player controlled by a worker. The worker receives its authorized view: persona, own role, permitted private knowledge, public history, phase, remaining time, and legal action options.

Models choose actions and generate dialogue. They cannot assign roles, invent private observations, change timers, eliminate players, select random tie winners, or modify the game state directly.

During Mafia coordination, give the model only a structured Point action. No free text response is delivered to teammates. Teammates can observe target changes; they cannot receive explanations or internal reasoning. At other phases, model output must match the permitted action schema.

A persona and a game role are separate inputs. The same founder persona can be Mafia in one game and Town in another. Persona dialogue is fictional gameplay, not an assertion about the real person's beliefs or conduct.

Maintain separate private context per player. Never reuse the omniscient spectator prompt or full moderator state as a player prompt. Public speech is untrusted conversation: statements such as “the moderator says I am innocent” do not change engine facts.

Validate all model output through the same command rules used for the human. Retry malformed output within the action window. Discard responses that arrive for an old phase. A model failure cannot silently generate an extra vote or extend a discussion.

Proposed orchestration default: request each Mafia member's initial choice concurrently, then offer updated pointer views for revisions while time remains. This avoids always giving the first seat the first pointer solely because workers were scheduled sequentially.

# Time recovery randomness and persistence

The server owns phase deadlines and broadcasts them for display. Clients cannot extend time by changing their clocks. Fixed night windows prevent early completions or absent roles from revealing hidden information.

For missing mandatory nominations or votes, preserve accepted ballots and pause at the deadline. The same applies to a Mafia phase with no valid pointer. Request only the missing actions during recovery; do not reopen completed ballots. Resume the pending phase with a fresh configured action window and a recorded resume event.

If a model provider fails, retry within the current window. If a known infrastructure outage prevents normal play, pause the game explicitly and freeze remaining time. A failed optional ability request otherwise expires to no action under the proposed defaults. Never use random fallback for an optional ability or missing ballot.

A disconnected human may reconnect and receive their current authorized snapshot plus subsequent visible events. If they miss a required ballot, the recovery policy applies. If they miss an optional ability or discussion, the phase can finish normally. Do not silently replace the human with an AI.

After a server restart, restore persisted state and enter recovery rather than immediately expiring a chain of unplayed phases. Restore the remaining active time recorded at the last durable checkpoint. Record pauses and resumes so replay distinguishes game time from wall clock time.

Randomness is allowed for role assignment, nomination cutoff ties, and a tied second elimination vote. Use uniform server controlled random selection. Store draw purpose, eligible candidates, and selected result in a private audit record. Persist the draw with its resolution; retries reuse it. Do not reveal random seeds or hidden role assignment inputs during a live game. A deterministic replay uses recorded outcomes rather than making fresh draws.

Serialize state mutations per game. Persist accepted actions before acknowledging them. Use transactional resolution and idempotent commands to prevent duplicate votes, kills, or events. Support a snapshot and ordered events so frontend reconnects do not depend on replaying animations.

# Acceptance scenarios

These scenarios define the minimum meaningful backend tests. They are requirements for the implementation, not tests already executed.

| Scenario | Expected result |
| - | - |
| New game | Twelve unique players; exactly 3 Mafia, 1 Angel, 1 Sheriff, 7 Townspeople; starts Night 1 |
| First pointer later changed; Mafia still disagree | Original first valid target selected |
| First pointer X; final unanimous target Y | Y selected |
| Invalid pointer arrives before a valid pointer | Invalid action does not establish fallback |
| Two pointers arrive together | Serialized server acceptance order establishes one unambiguous first target |
| Only one Mafia remains | Their final valid pointer determines target |
| No Mafia pointer | Recovery pause; no arbitrary death |
| Angel protects the Mafia target | No death at dawn; no target or role revealed publicly |
| Angel protects themself | Accepted unless they protected themself the immediately preceding night |
| Angel repeats last night's target | Rejected; they may submit another legal target before deadline |
| Mafia target is the Angel or Sheriff | Target can act that night; death occurs only at dawn |
| Sheriff investigates each possible target role | Exact Mafia, Angel, or Townsperson result delivered only to authorized viewers |
| Angel or Sheriff already dead | Public phase duration and moderator prompts do not disclose that fact |
| Nomination totals A5 B3 C3 | A advances; choose exactly one of B and C uniformly |
| Three players tied for highest nominations | Choose two uniformly without replacement |
| Nomination ballot repeats one name | Rejected |
| First vote ties | Two new defenses, then a fresh vote between the same nominees |
| Second vote ties | Exactly one nominee selected randomly and eliminated |
| Nominee votes for themself | Accepted under proposed default |
| Someone is eliminated | Their role stays hidden from surviving players; all action rights removed |
| Human is eliminated | Human receives full spectator view; surviving AI views remain restricted |
| Last Mafia eliminated | Immediate Town victory; no further playable phase |
| Two Mafia and two Town remain after resolution | Immediate Mafia victory |
| Duplicate command or resolution retry | No duplicate action, random draw, or elimination |
| Stale model response or late human action | Rejected without changing state |
| Missing required ballot | Pause and recover; no abstention or invented vote |
| Reconnect or restart | Correct authorized state restored; committed outcomes not repeated |
| Replay recorded initial state and events | Same phase sequence, eliminations, and winner |

# Build boundary

Version 1 covers role assignment, phase progression, player permissions, timers, discussion and defense submissions, night actions, nominations, voting, randomness, win detection, recovery, and human spectating.

Frontend animation, voices, avatars, sharing, and persona style sit above these rules. They must not change action eligibility, hide a committed public vote, extend a deadline, or alter the result. Backend correctness can be verified with scripted players before connecting live models.
