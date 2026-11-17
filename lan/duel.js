(() => {
  'use strict';

  const TEAM_SIZE = 5;
  const DUEL = { name: 'Duel', limit: 10 };
  const TDM = { name: 'Team Deathmatch', limit: 40 };
  const RESPAWN_SECONDS = 3.6;
  const SNAPSHOT_MS = 33;

  const NAME_KEY = 'solstice-lan-name';
  const STANCES = ['stand', 'crouch', 'prone', 'slide', 'dive'];
  const finite = (value, max) => Number.isFinite(value) && Math.abs(value) <= max;
  const triple = (value, max) => Array.isArray(value) && value.length === 3 && value.every(n => finite(n, max));
  const propPose = body => body && !body.dead ? {
    pos: body.obj.position.toArray(), rotation: body.obj.quaternion.toArray(),
  } : null;

  class LanMatch {
    constructor(api) {
      this.api = api;
      this.ctx = api.ctx;
      this.match = api.ctx.match;
      this.player = api.ctx.player;
      this.socket = null;
      this.active = false;
      this.peers = new Map();
      this.peerPool = [[], []];
      this.extraBots = [];
      this.corpseRigs = [[], []];
      this.opponentCorpses = [];
      this.nades = new Map();
      this.lastSent = 0;
      this.dialog = this.makeDialog();
      this.installHooks();
      if (new URLSearchParams(location.search).has('lan')) this.open();
    }

    get host() { return this.seat === 0; }
    get teamMatch() { return this.mode !== DUEL; }
    get opposingHumans() { return [...this.peers.values()].some(peer => peer.actor.team !== this.player.team); }

    makeDialog() {
      const dialog = document.createElement('dialog');
      dialog.id = 'lan-duel';
      dialog.setAttribute('aria-labelledby', 'lan-title');
      dialog.innerHTML = `
        <h2 id="lan-title">LAN Multiplayer</h2>
        <p data-result hidden></p>
        <p role="status" data-status></p>
        <div class="lan-fields">
          <label hidden data-addresses>Join address
            <textarea readonly rows="1" aria-label="LAN join addresses"></textarea>
          </label>
          <label hidden data-profile>Display name
            <input type="text" maxlength="20" autocomplete="nickname" spellcheck="false">
          </label>
          <label hidden data-difficulty>Bot difficulty
            <select>
              <option value="recruit">Recruit</option>
              <option value="regular">Regular</option>
              <option value="hardened">Hardened</option>
              <option value="veteran">Veteran</option>
            </select>
          </label>
        </div>
        <div class="lan-teams" hidden>
          <section class="lan-team t0" aria-label="Vanguard">
            <h3 class="lan-team-heading"></h3>
            <ul class="lan-roster"></ul>
          </section>
          <div class="lan-move" hidden>
            <button type="button" data-move="0" aria-label="Move selected operator to Vanguard">&larr;</button>
            <button type="button" data-move="1" aria-label="Move selected operator to Ember">&rarr;</button>
          </div>
          <section class="lan-team t1" aria-label="Ember">
            <h3 class="lan-team-heading"></h3>
            <ul class="lan-roster"></ul>
          </section>
        </div>
        <div class="lan-bots" hidden>
          <button class="nv" type="button" data-add="0" aria-label="Add bot to Vanguard"><b>Add bot</b></button>
          <button class="btn" type="button" data-remove>Remove</button>
          <button class="nv" type="button" data-add="1" aria-label="Add bot to Ember"><b>Add bot</b></button>
        </div>
        <div class="lan-actions">
          <button class="btn" type="button" data-ready hidden>Ready</button>
          <button class="btn" type="button" data-start hidden>Start match</button>
          <button class="btn" type="button" data-retry hidden>Reconnect</button>
          <button class="btn ghost" type="button" data-back>Main menu</button>
        </div>`;
      document.body.append(dialog);
      const select = selector => dialog.querySelector(selector);
      this.title = select('h2');
      this.result = select('[data-result]');
      this.status = select('[data-status]');
      this.addresses = select('[data-addresses]');
      this.addressField = select('textarea');
      this.difficultyLabel = select('[data-difficulty]');
      this.difficultyField = select('select');
      this.profile = select('[data-profile]');
      this.nameField = this.profile.querySelector('input');
      this.teams = select('.lan-teams');
      this.teamHeaders = [...dialog.querySelectorAll('.lan-team-heading')];
      this.teamLists = [...dialog.querySelectorAll('.lan-roster')];
      this.moveButtons = [...dialog.querySelectorAll('[data-move]')];
      this.botControls = select('.lan-bots');
      this.addButtons = [...dialog.querySelectorAll('[data-add]')];
      this.removeBot = select('[data-remove]');
      this.readyButton = select('[data-ready]');
      this.startButton = select('[data-start]');
      this.retryButton = select('[data-retry]');
      this.nameField.onchange = () => this.sendProfile(false);
      this.difficultyField.onchange = () => this.configure('difficulty', { difficulty: this.difficultyField.value });
      this.moveButtons.forEach((button, team) => button.onclick = () => this.moveSelected(team));
      this.addButtons.forEach((button, team) => button.onclick = () => this.configure('add', { team }));
      this.removeBot.onclick = () => this.configure('remove', { id: this.selectedId });
      this.readyButton.onclick = () => {
        this.readyButton.disabled = true;
        this.sendProfile(!this.lobbyRoster.find(row => row.id === this.seat)?.ready);
      };
      this.startButton.onclick = () => {
        this.startButton.disabled = true;
        this.sendProfile(false);
        this.send({ type: 'start' });
      };
      this.retryButton.onclick = () => this.connect();
      select('[data-back]').onclick = () => this.leave();
      dialog.addEventListener('cancel', event => { event.preventDefault(); this.leave(); });
      dialog.addEventListener('keydown', event => {
        event.stopPropagation();
        if (this.host && !event.target.matches('input, textarea, select')) this.lobbyKey(event);
      });
      this.addressField.addEventListener('focus', () => this.addressField.select());
      return dialog;
    }

    configure(action, settings) {
      this.send({ type: 'configure', action, ...settings });
    }

    operatorButton(id) {
      return this.teams.querySelector(`[data-operator="${id}"]`);
    }

    moveSelected(team) {
      const selected = this.lobbyRoster.find(row => row.id === this.selectedId);
      if (!selected || selected.team === team) return;
      if (this.teamCounts[team] < TEAM_SIZE) {
        this.configure('move', { team, id: selected.id });
      } else {
        this.swapTeam = this.swapTeam === team ? null : team;
        this.updateLobbySelection();
        if (this.swapTeam !== null) this.teamLists[team].querySelector('.lan-operator')?.focus();
      }
    }

    chooseOperator(row) {
      if (this.swapTeam === row.team) {
        this.configure('swap', { id: this.selectedId, other: row.id });
      } else {
        this.selectedId = row.id;
      }
      this.swapTeam = null;
      this.updateLobbySelection();
    }

    lobbyKey(event) {
      if (this.teams.hidden || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      const selected = this.lobbyRoster.find(row => row.id === this.selectedId);
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        if (!event.repeat) this.moveSelected(Number(event.key === 'ArrowRight'));
        return;
      }
      const team = this.swapTeam ?? selected?.team ?? this.lobbyRoster[0]?.team;
      const rows = this.lobbyRoster.filter(row => row.team === team);
      if (!rows.length) return;
      const id = this.swapTeam === null ? this.selectedId : Number(document.activeElement?.dataset.operator);
      const index = rows.findIndex(row => row.id === id);
      const next = index < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1)));
      if (this.swapTeam === null) this.chooseOperator(rows[next]);
      this.operatorButton(rows[next].id)?.focus();
    }

    setDropTarget(slot) {
      if (this.dropTarget === slot) return;
      this.dropTarget?.classList.remove('lan-drop-target');
      this.dropTarget = slot;
      slot?.classList.add('lan-drop-target');
    }

    setupDropSlot(slot, team, row) {
      slot.ondragover = event => {
        const dragged = this.lobbyRoster.find(item => item.id === this.draggedId);
        if (!dragged || dragged.team === team) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        this.setDropTarget(slot);
      };
      slot.ondragleave = event => {
        if (this.dropTarget === slot && !slot.contains(event.relatedTarget)) this.setDropTarget(null);
      };
      slot.ondrop = event => {
        const dragged = this.lobbyRoster.find(item => item.id === this.draggedId);
        if (!dragged || dragged.team === team) return;
        event.preventDefault();
        this.setDropTarget(null);
        this.draggedId = null;
        this.selectedId = dragged.id;
        this.swapTeam = null;
        this.updateLobbySelection();
        if (row) this.configure('swap', { id: dragged.id, other: row.id });
        else this.configure('move', { id: dragged.id, team });
      };
    }

    sendProfile(ready) {
      const name = this.nameField.value.trim();
      try { localStorage.setItem(NAME_KEY, name); } catch {}
      this.send({ type: 'profile', name, ready, revision: this.lobbyRevision });
    }

    showLobbyControls(connected) {
      const hostControls = connected && this.host;
      this.profile.hidden = this.teams.hidden = !connected;
      this.readyButton.hidden = !connected || this.host;
      this.startButton.hidden = this.botControls.hidden = !hostControls;
      this.difficultyLabel.hidden = !connected;
      this.difficultyField.disabled = !hostControls;
      this.teams.querySelector('.lan-move').classList.toggle('lan-readonly', !hostControls);
      this.teams.querySelector('.lan-move').hidden = !connected;
      if (!connected) this.addresses.hidden = true;
    }

    open() {
      if (!this.dialog.open) this.dialog.showModal();
      if (this.socket) return;
      if (location.protocol === 'file:') {
        this.status.textContent = 'Run Start-LAN.bat in the game folder to host. To join, open the address shared by your host.';
        return;
      }
      this.connect();
    }

    connect() {
      if (this.socket) return;
      this.seat = null;
      this.lobbyRoster = [];
      this.selectedId = null;
      this.swapTeam = null;
      this.draggedId = null;
      this.result.hidden = true;
      this.title.textContent = 'LAN Multiplayer';
      this.status.textContent = 'Connecting to the LAN lobby…';
      this.showLobbyControls(false);
      this.retryButton.hidden = true;
      const socket = new WebSocket(`ws://${location.host}/lan/socket`);
      this.socket = socket;
      socket.onopen = () => {
        this.keepAlive = setInterval(() => this.send({ type: 'ping' }), 3000);
      };
      socket.onmessage = event => {
        if (this.socket === socket) this.receive(JSON.parse(event.data));
      };
      socket.onclose = () => {
        if (this.socket !== socket) return;
        this.closeSocket();
        if (this.active) this.stopRound();
        this.status.textContent = this.seat === null
          ? 'Could not connect. Open the game through Start-LAN.bat or use the host’s join address.'
          : this.seat === 'full' ? 'This LAN lobby is full. Ask the host to free a slot.'
            : this.seat === 'busy' ? 'A match is in progress. Reconnect after it ends.'
              : this.seat === 'old' ? 'Close the LAN server and reopen Start-LAN.bat to load the new lobby.'
                : this.seat === 'removed' ? 'The host removed you from the lobby. Refresh the page to rejoin.'
                  : 'Disconnected from the LAN server.';
        this.showLobbyControls(false);
        this.result.hidden = true;
        this.retryButton.hidden = this.seat === 'removed';
        if (!this.dialog.open) this.dialog.showModal();
      };
    }

    closeSocket() {
      const socket = this.socket;
      this.socket = null;
      clearInterval(this.keepAlive);
      socket?.close();
    }

    leave() {
      this.closeSocket();
      if (this.active) this.stopRound();
      this.dialog.close();
    }

    send(message) {
      if (this.socket?.readyState !== WebSocket.OPEN) return;
      if (this.socket.bufferedAmount > 65_536 && ['pose', 'state'].includes(message.type)) return;
      this.socket.send(JSON.stringify(message));
    }

    receive(message) {
      switch (message.type) {
        case 'welcome':
          if (message.lobby !== 3) {
            this.seat = 'old';
            this.socket.close();
            return;
          }
          this.seat = message.seat;
          this.addresses.hidden = !this.host || !message.addresses.length;
          this.addressField.rows = Math.min(2, Math.max(1, message.addresses.length));
          this.addressField.value = message.addresses.join('\n');
          this.nameField.value = '';
          try { this.nameField.value = localStorage.getItem(NAME_KEY) || ''; } catch {}
          this.nameField.placeholder = this.host ? 'Host' : `Guest ${this.seat}`;
          this.showLobbyControls(true);
          if (this.nameField.value) this.sendProfile(false);
          break;
        case 'full':
        case 'busy':
          this.seat = message.type;
          break;
        case 'removed':
          this.seat = 'removed';
          this.socket.close();
          break;
        case 'lobby':
          this.lobbyRoster = message.roster;
          this.lobbyDifficulty = message.difficulty;
          this.lobbyRevision = message.revision;
          if (!this.active) this.updateLobby();
          break;
        case 'start':
          this.beginRound(message.roster, message.difficulty);
          break;
        case 'departed':
          if (this.active) this.removePeer(message.seat);
          break;
        case 'abort':
        case 'cancel':
          if (this.active) this.cancelRound(message.type === 'abort' ? 'Host disconnected' : 'Team disconnected');
          break;
        case 'pose':
        case 'action': {
          const peer = this.peers.get(message.seat);
          if (!this.active || !this.host || !peer) break;
          if (message.type === 'pose') this.acceptPose(peer, message.pose);
          else this.acceptAction(peer, message);
          break;
        }
        case 'state':
          if (this.active && !this.host) this.applyState(message);
          break;
        case 'event':
          if (this.active && !this.host) this.applyEvent(message);
          break;
        case 'finish':
          if (this.active && !this.host) this.finish(message.scores, message.playerScores[this.seat]);
          break;
      }
    }

    updateLobby() {
      if (this.draggedId !== null) return;
      const humans = this.lobbyRoster.filter(row => !row.bot);
      const self = humans.find(row => row.id === this.seat);
      const ready = humans.filter(row => row.ready).length;
      const hostPresent = humans.some(row => row.id === 0);
      this.teamCounts = [0, 1].map(team => this.lobbyRoster.filter(row => row.team === team).length);
      const populated = this.teamCounts.every(Boolean);
      this.difficultyField.value = this.lobbyDifficulty;
      this.nameField.disabled = !this.host && !!self?.ready;
      this.readyButton.disabled = !self || !hostPresent;
      this.readyButton.textContent = self?.ready ? 'Unready' : 'Ready';
      this.startButton.disabled = !populated || ready !== humans.length;
      this.startButton.textContent = populated && ready === humans.length
        ? 'Start match' : `Waiting (${ready}/${humans.length})`;
      this.lobbyStatus = this.host
        ? !populated ? 'Add a bot or invite a player to fill the other team.'
          : ready === humans.length ? 'Both teams are ready.' : 'Waiting for players to ready up.'
        : !hostPresent ? 'Waiting for the host.' : self?.ready
          ? 'Ready. Waiting for the host to start.' : 'Ready up when you’re set.';

      const focusedId = document.activeElement?.dataset.operator;
      this.teamLists.forEach((list, team) => {
        this.teamHeaders[team].textContent = `${this.api.teamNames[team]} ${this.teamCounts[team]}/${TEAM_SIZE}`;
        const rows = this.lobbyRoster.filter(row => row.team === team);
        list.replaceChildren();
        for (let slot = 0; slot < TEAM_SIZE; slot++) {
          const row = rows[slot];
          const li = document.createElement('li');
          list.append(li);
          if (this.host) this.setupDropSlot(li, team, row);
          if (!row) {
            li.className = 'lan-empty';
            li.textContent = 'Open slot';
            continue;
          }
          const entry = document.createElement(this.host ? 'button' : 'div');
          const name = document.createElement('strong');
          const state = document.createElement('span');
          name.textContent = row.name + (row.id === this.seat ? ' (you)' : '');
          state.textContent = row.bot ? 'Bot' : row.ready ? 'Ready' : 'Not ready';
          entry.className = 'lan-operator';
          entry.append(name, state);
          li.append(entry);
          if (this.host) {
            entry.type = 'button';
            entry.dataset.operator = row.id;
            entry.onclick = () => this.chooseOperator(row);
            entry.draggable = true;
            entry.ondragstart = event => {
              this.draggedId = this.selectedId = row.id;
              this.swapTeam = null;
              event.dataTransfer.setData('text/plain', row.name);
              event.dataTransfer.effectAllowed = 'move';
              this.updateLobbySelection();
            };
            entry.ondragend = () => {
              this.draggedId = null;
              this.setDropTarget(null);
              this.updateLobby();
            };
          }
        }
      });
      if (!this.lobbyRoster.some(row => row.id === this.selectedId)) this.selectedId = this.swapTeam = null;
      this.updateLobbySelection();
      if (focusedId !== undefined) this.operatorButton(focusedId)?.focus();
    }

    updateLobbySelection() {
      const selected = this.lobbyRoster.find(row => row.id === this.selectedId);
      this.status.textContent = this.swapTeam === null
        ? this.lobbyStatus : `Select an operator on ${this.api.teamNames[this.swapTeam]} to swap with ${selected.name}.`;
      this.moveButtons.forEach((button, team) => {
        const verb = this.teamCounts[team] === TEAM_SIZE ? 'Swap with an operator on' : 'Move selected operator to';
        button.disabled = !selected || selected.team === team;
        button.title = `${verb} ${this.api.teamNames[team]}`;
        button.setAttribute('aria-label', button.title);
        button.setAttribute('aria-pressed', this.swapTeam === team);
        this.teamLists[team].classList.toggle('lan-swap-target', this.swapTeam === team);
      });
      this.addButtons.forEach((button, team) => button.disabled = this.teamCounts[team] >= TEAM_SIZE);
      this.removeBot.disabled = !selected || selected.id === this.seat;
      for (const entry of this.teams.querySelectorAll('[data-operator]')) {
        entry.setAttribute('aria-pressed', Number(entry.dataset.operator) === this.selectedId);
      }
    }

    beginRound(roster, difficulty) {
      const { ctx, match, player } = this;
      const self = roster.find(row => row.id === this.seat);
      this.dialog.close();
      this.mode = roster.length === 2 && roster.every(row => !row.bot) ? DUEL : TDM;
      this.active = true;
      this.hasState = this.host;
      this.lastSent = 0;
      this.nextGrenade = 0;
      this.nextSupplyId = 0;
      this.supplyDrops = new Map();
      this.lastCount = 4;
      this.endTime = 0;
      this.spawnId = 0;
      this.opposingCharge = this.api.k9Tuning.chargeStart;
      this.opposingK9Ready = false;
      this.botReplicas = new Map();
      this.k9Replicas = new Map();
      this.actorIds = new Map();
      this.actorsById = new Map();
      this.offlinePlayer = { team: player.team, name: player.name, hit: player.hit };
      player.team = self.team;
      player.name = self.name;
      this.api.setPlayerTeam(player.team);
      this.offlineActors = match.actors;
      this.offlineBots = match.bots;
      this.botIdentities = this.offlineBots.map(bot => ({ name: bot.name, def: bot.def }));
      this.offlineScoreLimit = match.scoreLimit;
      match.lan = this.mode.name;
      match.lanDifficulty = difficulty;
      match.scoreLimit = this.mode.limit;
      match.actors = [player];
      match.bots = [];
      this.registerActor(this.seat, player);
      const spawns = [0, 0];
      const initialPoints = new Map();
      for (const row of roster) {
        if (row.bot) {
          if (!this.host) continue;
          match.bots.push(this.allocateBot(row.id, row.team, row.name));
        } else {
          initialPoints.set(row.id, this.api.spawns[row.team][spawns[row.team]++]);
          if (row.id !== this.seat) this.makePeer(row);
        }
      }
      // Keep bots immediately after the local operator for minimap and K9 blip updates.
      match.actors.push(...match.bots, ...[...this.peers.values()].map(peer => peer.actor));
      match.clearAmmoDrops();
      match.k9.reset();
      match.scores = [0, 0];
      match.state = 'countdown';
      match.live = false;
      match.countdown = 3.4;
      match.resetClock();
      match.feed.length = 0;
      match.lastFrag = -Infinity;
      this.resetMapBlips();
      ctx.physics.reset();
      ctx.glass.reset();
      ctx.resetWorld();
      for (const actor of match.actors) {
        actor.kills = actor.deaths = actor.score = actor.streak = 0;
        actor.alive = false;
        actor._k9hit = actor.k9Pin = null;
      }
      player.stats.shots = player.stats.hits = player.stats.head = 0;
      ctx.hud.matchStart();
      this.spawn(initialPoints.get(this.seat));
      for (const peer of this.peers.values()) this.spawnOpponent(peer, initialPoints.get(peer.id));
      if (this.host) for (const bot of match.bots) {
        match.respawn(bot, true);
        bot.fragP = null;
      }
      document.body.classList.toggle('lan-playing', !this.teamMatch);
      this.api.enter();
      ctx.hud.hint('<span>CLICK THE GAME TO CAPTURE YOUR MOUSE</span>', 5);
      if (this.host) this.publish();
    }

    stopRound() {
      this.active = false;
      this.supplyDrops.clear();
      for (const peer of this.peers.values()) this.releasePeer(peer);
      this.peers.clear();
      for (const corpse of this.opponentCorpses) this.freeOpponentCorpse(corpse);
      this.opponentCorpses.length = 0;
      this.match.k9.clear();
      this.offlineBots.forEach((bot, index) => {
        this.hideBot(bot);
        Object.assign(bot, this.botIdentities[index]);
      });
      for (const bot of this.extraBots) this.hideBot(bot);
      for (const [id, replica] of this.k9Replicas) this.hideK9(id, replica);
      this.botReplicas.clear();
      this.k9Replicas.clear();
      this.match.actors = this.offlineActors;
      this.match.bots = this.offlineBots;
      this.match.scoreLimit = this.offlineScoreLimit;
      this.match.resetClock();
      this.match.lan = false;
      delete this.match.lanDifficulty;
      Object.assign(this.player, this.offlinePlayer);
      this.api.setPlayerTeam(this.player.team);
      this.resetMapBlips();
      this.ctx.physics.reset();
      this.ctx.glass.reset();
      this.ctx.resetWorld();
      for (const grenade of this.nades.values()) this.ctx.botCtx.scene.remove(grenade.obj);
      this.nades.clear();
      document.body.classList.remove('lan-playing');
      this.api.menu();
    }

    finish(scores, playerScore = this.player.score) {
      if (!this.active) return;
      const ours = scores[this.player.team];
      const theirs = scores[1 - this.player.team];
      const mode = this.mode.name;
      const award = this.api.awardMatch(playerScore, ours > theirs);
      this.stopRound();
      for (const row of this.lobbyRoster) if (!row.bot && row.id !== 0) row.ready = false;
      this.updateLobby();
      this.title.textContent = ours === theirs ? 'Draw' : ours > theirs ? 'Victory' : 'Defeat';
      this.result.textContent = `${mode} · ${this.api.teamNames[0]} ${scores[0]} – ${scores[1]} ${this.api.teamNames[1]} · +${award.gained.toLocaleString()} XP`;
      this.result.hidden = false;
      this.dialog.showModal();
    }

    cancelRound(title) {
      this.stopRound();
      this.title.textContent = title;
      this.result.hidden = true;
      this.updateLobby();
      if (!this.dialog.open) this.dialog.showModal();
    }

    makePeer({ id, team, name }) {
      const { botCtx } = this.ctx;
      const peer = this.peerPool[team].pop() || {};
      Object.assign(peer, { id, pose: null, life: 0, rigWeapon: '', remoteBuild: null });
      if (!peer.rig) {
        peer.renderPos = new this.api.Vector();
        peer.rig = botCtx.createCharacter({
          team,
          gunFactory: weapon => botCtx.worldGun(weapon, peer.remoteBuild),
          // Follow the sent vault pose without planting feet on furniture locally.
          ground: (x, z, y) => peer.pose?.mantle ? y - .5 : this.ctx.world.groundAt(x, z, y),
        });
        botCtx.scene.add(peer.rig.root);
      }
      const vector = () => new this.api.Vector();
      peer.actor = {
        team, name, isPlayer: false, alive: false, health: 100,
        lanHuman: true, tagRig: peer.rig, pos: vector(), eye: vector(), vel: vector(), viewDir: vector(),
        e: { h: 1.8, onGround: true }, def: this.api.weapons.ar, hit: peer.rig.hit,
        lastHurt: -Infinity, lastShot: -Infinity, kickPitch: 0, kickRoll: 0, addShake() {},
      };
      this.peers.set(id, peer);
      this.registerActor(id, peer.actor);
    }

    releasePeer(peer) {
      peer.actor.alive = false;
      peer.rig.root.visible = false;
      this.peerPool[peer.actor.team].push(peer);
    }

    removePeer(id) {
      const peer = this.peers.get(id);
      if (!peer) return;
      this.peers.delete(id);
      this.releasePeer(peer);
      const { actors } = this.match;
      actors.splice(actors.indexOf(peer.actor), 1);
      this.resetMapBlips();
      // Keep the actor identity for damage from any grenade or K9 already deployed.
      if (this.host && !actors.some(actor => !actor.isK9 && actor.team === peer.actor.team)) {
        this.send({ type: 'cancel' });
        this.cancelRound('Team disconnected');
      }
    }

    registerActor(id, actor) {
      this.actorIds.set(actor, id);
      this.actorsById.set(id, actor);
    }

    actorId(actor) { return actor ? this.actorIds.get(actor) ?? null : null; }

    allocateBot(id, team, name) {
      let bot = [...this.offlineBots, ...this.extraBots]
        .find(candidate => candidate.team === team && !this.actorIds.has(candidate));
      if (!bot) {
        bot = this.api.makeBot(team);
        this.extraBots.push(bot);
      }
      this.hideBot(bot);
      bot.name = name;
      this.registerActor(id, bot);
      return bot;
    }

    hideBot(bot) {
      bot.alive = false;
      for (const rig of bot.rigs) {
        rig.root.visible = false;
        rig.setOpacity(1);
        bot._freeCorpse(rig);
      }
    }

    resetMapBlips() {
      const blips = this.ctx.hud.map.blips;
      for (const blip of blips) blip?.el.remove();
      blips.length = 0;
    }

    spawn(point, generation = this.spawnId + 1) {
      this.spawnId = generation;
      this.player.spawn(...point.pos, point.yaw);
      this.player.eye.copy(this.player.pos).y += this.player.eyeH;
      this.player.spawnT = this.ctx.time();
      this.ctx.arsenal.reset(this.ctx.settings.primary);
      this.ctx.hud.respawned();
      if (this.host) {
        this.hostHitRig ??= this.ctx.botCtx.createCharacter({
          team: this.player.team,
          gunFactory: id => this.ctx.botCtx.worldGun(id, this.hostHitWeapon?.build),
          ground: (x, z, y) => this.player.mode === 'mantle' ? y - .5 : this.ctx.world.groundAt(x, z, y),
        });
        this.hostHitRig.reset();
        this.updateHostHit(1 / 60);
        this.player.hit = this.hostHitRig.hit;
      }
    }

    spawnOpponent(peer, point = this.match.pickSpawn(peer.actor, false)) {
      const { actor } = peer;
      const pos = point.pos || [point.x, point.y || 0, point.z];
      peer.life++;
      peer.frags = this.api.grenadeCapacity;
      peer.lastPoseAt = -Infinity;
      peer.lastFire = peer.lastMelee = -Infinity;
      peer.fireBudget = 2;
      actor.alive = true;
      actor.health = 100;
      actor.k9Pin = null;
      actor.lastHurt = actor.lastShot = -Infinity;
      actor.spawnT = this.ctx.time();
      this.setOpponentPose(peer, { life: peer.life, pos, yaw: point.yaw, pitch: 0, h: 1.8,
        eyeH: 1.66, stance: 'stand', weapon: 'ar' }, true);
    }

    playerStance() {
      const { player } = this;
      return player.mode === 'slide' || player.mode === 'dive' ? player.mode
        : player.mode === 'bellyslide' ? 'prone' : player.stance;
    }

    localPose() {
      const { player, ctx } = this;
      return {
        life: this.spawnId, pos: player.pos.toArray(), vel: player.vel.toArray(), yaw: Math.atan2(Math.sin(player.yaw), Math.cos(player.yaw)),
        pitch: player.pitch, h: player.e.h, eyeH: player.eyeH, stance: this.playerStance(), airborne: !player.e.onGround,
        lean: player.lean,
        sprint: player.sprinting, reloading: ctx.arsenal.state === 'reload', weapon: ctx.arsenal.def.id,
        build: ctx.arsenal.def.build, inWater: player.inWater, mantle: player.mode === 'mantle',
      };
    }

    acceptPose(peer, pose) {
      const { actor } = peer;
      if (!pose || !actor.alive || pose.life !== peer.life || !triple(pose.pos, 160) || !triple(pose.vel, 80)
          || !finite(pose.yaw, Math.PI) || !finite(pose.pitch, 1.6) || !finite(pose.h, 2.1)
          || !finite(pose.lean ?? 0, 1)
          || pose.h < .2 || !finite(pose.eyeH, 2) || pose.eyeH < .1 || !STANCES.includes(pose.stance)
          || typeof pose.weapon !== 'string' || !Object.hasOwn(this.api.weapons, pose.weapon)) return false;
      const now = performance.now();
      const position = this.vector(pose.pos);
      const distance = actor.pos.distanceTo(position);
      if (distance > 3 + 24 * Math.min(2, (now - peer.lastPoseAt) / 1000)) return false;
      peer.lastPoseAt = now;
      pose.build = this.api.cleanBuild(pose.weapon, pose.build);
      const canLean = !pose.airborne && !pose.sprint && !pose.mantle && !pose.inWater && !actor.k9Pin
        && (pose.stance === 'stand' || pose.stance === 'crouch');
      pose.lean = canLean
        ? this.api.limitLean(this.ctx.world, position, pose.eyeH, pose.yaw, pose.lean ?? 0) : 0;
      this.setOpponentPose(peer, pose);
      return true;
    }

    setOpponentPose(peer, pose, snap = false) {
      const { actor: remote } = peer;
      peer.pose = pose;
      remote.pos.fromArray(pose.pos);
      remote.vel.fromArray(pose.vel || [0, 0, 0]);
      remote.eye.copy(remote.pos).y += pose.eyeH;
      const offset = (pose.lean ?? 0) * this.api.leanDistance;
      remote.eye.x += Math.cos(pose.yaw) * offset;
      remote.eye.z -= Math.sin(pose.yaw) * offset;
      const { x, y, z } = remote.pos;
      Object.assign(remote.e, { x, y, z, h: pose.h, onGround: !pose.airborne });
      remote.yaw = pose.yaw;
      remote.sprinting = !!pose.sprint;
      remote.mode = pose.mantle ? 'mantle' : pose.stance;
      remote.inWater = !!pose.inWater;
      const cosPitch = Math.cos(pose.pitch);
      remote.viewDir.set(-Math.sin(pose.yaw) * cosPitch, Math.sin(pose.pitch), -Math.cos(pose.yaw) * cosPitch);
      remote.def = this.api.weapons[pose.weapon];
      if (snap) {
        peer.renderPos.copy(remote.pos);
        peer.renderYaw = pose.yaw;
        peer.renderLean = pose.lean ?? 0;
        peer.rig.reset();
        this.renderOpponent(peer, 1 / 60);
      }
    }

    updateHostHit(dt) {
      const { player, ctx, hostHitRig } = this;
      if (!player.alive) return;
      const weapon = ctx.arsenal.def;
      if (this.hostHitWeapon !== weapon) {
        this.hostHitWeapon = weapon;
        hostHitRig.setWeapon(weapon.id);
      }
      // The host is judged against the same third-person pose the guest sees.
      // This rig isn't added to the scene and only supplies hit volumes.
      hostHitRig.update(dt, {
        pos: player.pos, yaw: player.yaw, pitch: player.pitch, stance: this.playerStance(), lean: player.lean,
        airborne: !player.e.onGround || player.mode === 'mantle', sprint: player.sprinting,
        reloading: ctx.arsenal.state === 'reload',
      });
    }

    renderOpponent(peer, dt) {
      const { actor, rig, pose } = peer;
      rig.root.visible = actor.alive && !!pose;
      if (!rig.root.visible) return;
      const key = pose.weapon + JSON.stringify(pose.build || {});
      if (key !== peer.rigWeapon) {
        peer.remoteBuild = pose.build;
        rig.setWeapon(pose.weapon);
        peer.rigWeapon = key;
      }
      const alpha = 1 - Math.exp(-24 * dt);
      peer.renderPos.lerp(actor.pos, alpha);
      peer.renderYaw = this.lerpAngle(peer.renderYaw, pose.yaw, alpha);
      peer.renderLean += ((pose.lean ?? 0) - peer.renderLean) * alpha;
      rig.update(dt, { ...pose, pos: peer.renderPos, yaw: peer.renderYaw, lean: peer.renderLean,
        airborne: pose.airborne || pose.mantle });
    }

    dropOpponentCorpse(team, pose, hit) {
      if (!pose) return null;
      const { botCtx } = this.ctx;
      let rig = this.corpseRigs[team].pop();
      if (!rig) {
        rig = botCtx.createCharacter({ team, ground: (x, z, y) => this.ctx.world.groundAt(x, z, y) });
        botCtx.scene.add(rig.root);
      }
      rig.reset();
      rig.setOpacity(1);
      rig.root.visible = true;
      rig.update(1 / 60, { ...pose, pos: this.vector(pose.pos) });
      const vel = this.vector(pose.vel || [0, 0, 0]);
      for (let i = 0; i < rig.jointVel.length; i += 3) vel.toArray(rig.jointVel, i);
      const corpse = { char: rig, body: this.api.dropRagdoll(rig, vel, hit), t: 0 };
      this.opponentCorpses.push(corpse);
      return corpse;
    }

    freeOpponentCorpse(corpse) {
      corpse.char.root.visible = false;
      this.ctx.physics.removeBody(corpse.body);
      this.corpseRigs[corpse.char.team].push(corpse.char);
    }

    vector(array) { return new this.api.Vector().fromArray(array); }

    event(kind, data = {}, to) {
      this.send({ type: 'event', kind, ...data, to });
    }

    cueTeam(team, cue, data = {}) {
      for (const { id, actor } of this.peers.values()) {
        if (actor.team === team) this.event('k9Hud', { cue, ...data }, id);
      }
    }

    action(kind, data = {}) { this.send({ type: 'action', kind, pose: this.localPose(), ...data }); }

    installHooks() {
      const { ctx, match } = this;
      const { combat, physics, glass } = ctx;
      const k9 = match.k9;
      ctx.reportSupplyPickup = drop => {
        if (!this.active || this.host) return false;
        if (drop?.supplyId !== undefined) this.action('resupply', { supplyId: drop.supplyId });
        return true;
      };
      this.player.ctx.reportFallDamage = () => {
        if (!this.active || this.host) return false;
        if (match.live) {
          // Landing is detected before the player copies the collision position into the pose.
          const { x, y, z } = this.player.e;
          this.action('land', { pose: { ...this.localPose(), pos: [x, y, z] } });
        }
        return true;
      };
      this.offline = {
        update: match.update.bind(match), damage: match.damage.bind(match), kill: match._kill.bind(match),
        fire: combat.fire.bind(combat), melee: combat.melee.bind(combat), explode: combat.explode.bind(combat),
        grenade: physics.throwGrenade.bind(physics), shatter: glass.shatter.bind(glass),
        k9Request: k9.request.bind(k9), k9Release: k9.release.bind(k9),
        k9Add: k9._add.bind(k9), k9Sound: k9.sfx.bind(k9), k9Hud: k9.hudEvent.bind(k9),
        enemyTimer: k9._enemyTimer.bind(k9),
      };
      match.update = (dt, realDt) => this.active ? this.tick(dt, realDt) : this.offline.update(dt, realDt);
      match.damage = (...args) => this.active ? this.damage(...args) : this.offline.damage(...args);
      match._kill = (target, source, hit) => {
        if (!this.active) return this.offline.kill(target, source, hit);
        if (this.host) this.kill(target, source, hit);
        else if (hit.weapon === 'fell') this.action('fall');
      };
      k9.request = () => {
        if (!this.active || this.teamMatch && this.host) return this.offline.k9Request();
        if (!this.teamMatch || !match.live || !this.player.alive) return false;
        if (k9.view.state !== 'ready' || this.player.inWater || this.player.mode === 'mantle') {
          k9._deny();
          return false;
        }
        return true;
      };
      k9.release = () => {
        if (!this.active || this.teamMatch && this.host) return this.offline.k9Release();
        if (!this.teamMatch || !match.live || !this.player.alive) return null;
        this.action('k9');
        return true;
      };
      k9._enemyTimer = dt => {
        if (!this.active || !this.opposingHumans) this.offline.enemyTimer(dt);
      };
      k9._add = unit => {
        this.offline.k9Add(unit);
        if (this.active && this.host) {
          const previous = this.actorsById.get(unit.id);
          if (previous) this.actorIds.delete(previous);
          this.registerActor(unit.id, unit);
          unit.lanLife = (unit.lanLife || 0) + 1;
          if (unit.team === this.player.team) this.cueTeam(1 - unit.team, 'enemy_inbound');
        }
      };
      const lost = k9.lost.bind(k9);
      k9.lost = (unit, reason, source) => {
        lost(unit, reason, source);
        if (!this.active || !this.host || unit.owner === this.player || !unit.owner?.lanHuman) return;
        if (unit.team === this.player.team) k9.hudEvent('lost', { reason, by: source });
        else this.cueTeam(unit.team, 'lost', { reason, by: this.actorId(source) });
      };

      k9.sfx = (kind, pos, options) => {
        this.offline.k9Sound(kind, pos, options);
        if (this.active && this.host && pos && kind !== 'step') this.event('k9Sound', { cue: kind, pos: pos.toArray(), options });
      };
      k9.hudEvent = (kind, info) => {
        this.offline.k9Hud(kind, info);
        if (!this.active || !this.host) return;
        if (['ready', 'deployed', 'takedown', 'lost', 'enemy_inbound', 'enemy_destroyed'].includes(kind)) {
          this.cueTeam(this.player.team, kind, { reason: info?.reason, by: this.actorId(info?.by) });
        }
      };
      combat.fire = (...args) => this.fire(...args);
      combat.melee = (...args) => this.melee(...args);
      combat.explode = (position, owner) => {
        if (this.active && this.host) this.event('explode', { pos: position.toArray(), owner: this.actorId(owner) });
        return this.offline.explode(position, owner);
      };
      physics.throwGrenade = (...args) => this.throwGrenade(...args);
      physics.hooks.onGrenadeBounce = position => {
        if (this.active && this.host) this.event('grenadeBounce', { pos: position.toArray() });
      };
      glass.shatter = (pane, a, y, direction, strength) => {
        if (this.active && !this.replaying && !pane.gone && !pane.cascade) {
          const data = { pane: pane.id, a, y, dir: direction.toArray(), strength };
          if (this.host) this.event('glass', data);
          else this.action('glass', data);
        }
        return this.offline.shatter(pane, a, y, direction, strength);
      };
    }

    fire(shooter, eye, dir, gun, spread, muzzle, scale) {
      if (!this.active) return this.offline.fire(shooter, eye, dir, gun, spread, muzzle, scale);
      if (!this.host) {
        if (this.match.live) this.action('fire', { eye: eye.toArray(), dir: dir.toArray(), spread });
        return { actor: null, head: false };
      }
      if (!this.match.live) return { actor: null, head: false };
      const result = this.offline.fire(shooter, eye, dir, gun, spread, muzzle, scale);
      this.event('shot', {
        owner: this.actorId(shooter), weapon: gun.id, suppressed: gun.suppressed,
        start: muzzle.toArray(), end: result.point.toArray(), dir: dir.toArray(),
      });
      return result;
    }

    melee(shooter, eye, dir) {
      if (!this.active || this.host) return this.offline.melee(shooter, eye, dir);
      if (this.match.live) this.action('melee', { eye: eye.toArray(), dir: dir.toArray() });
      return null;
    }

    throwGrenade(mesh, position, velocity, fuse, owner) {
      if (!this.active) return this.offline.grenade(mesh, position, velocity, fuse, owner);
      if (!this.host) {
        if (this.match.live) this.action('grenade', { pos: position.toArray(), vel: velocity.toArray() });
        return;
      }
      const grenade = this.offline.grenade(mesh, position, velocity, fuse, owner);
      grenade.lanId = ++this.nextGrenade;
      return grenade;
    }

    acceptAction(peer, message) {
      if (!this.match.live || !this.acceptPose(peer, message.pose)) return;
      const { ctx } = this;
      const { actor: remote, pose } = peer;
      const { kind } = message;
      if (kind === 'fall' && remote.pos.y < -6.5) {
        this.kill(remote, null, { weapon: 'fell' });
      } else if (kind === 'land' && remote.e.onGround && pose.stance !== 'dive') {
        const { x, y, z } = remote.pos;
        const amount = this.api.fallDamage(-remote.vel.y);
        if (amount > 0 && Math.abs(y - ctx.world.groundAt(x, z, y, .12)) < .12) {
          this.damage(remote, amount, null, { weapon: 'fell' });
        }
      } else if (kind === 'k9' && this.teamMatch) {
        this.deployGuestK9(peer);
      } else if (kind === 'resupply') {
        this.refillGuestGrenade(peer, message.supplyId);
      } else if (kind === 'grenade' && peer.frags > 0 && triple(message.vel, 34)
          && triple(message.pos, 160) && remote.eye.distanceTo(this.vector(message.pos)) < 1.2) {
        peer.frags--;
        this.throwGrenade(ctx.buildGrenade(), this.vector(message.pos), this.vector(message.vel), 2.3, remote);
      } else if (kind === 'glass') {
        const pane = ctx.glass.panes[message.pane];
        if (pane && finite(message.a, 160) && finite(message.y, 40) && triple(message.dir, 1)
            && Math.abs(remote.pos.y - message.y) < 3 && Math.abs(remote.pos.toArray()[pane.axis] - pane.pos) < 3
            && Math.abs((pane.axis === 0 ? remote.pos.z : remote.pos.x) - message.a) < 3) {
          ctx.glass.shatter(pane, message.a, message.y, this.vector(message.dir), 1);
        }
      } else if ((kind === 'fire' || kind === 'melee') && triple(message.dir, 1.01) && triple(message.eye, 160)) {
        const eye = this.vector(message.eye);
        const dir = this.vector(message.dir);
        if (eye.distanceTo(remote.eye) > .75 || dir.lengthSq() < .8) return;
        dir.normalize();
        const now = performance.now();
        if (kind === 'melee') {
          if (now - peer.lastMelee < 350) return;
          peer.lastMelee = now;
          this.melee(remote, eye, dir);
          return;
        }
        const gun = this.api.weaponDef(pose.weapon, pose.build);
        peer.fireBudget = Math.min(3, peer.fireBudget + (now - peer.lastFire) * gun.rpm / 60_000);
        peer.lastFire = now;
        if (peer.fireBudget < 1 || !finite(message.spread, 12) || message.spread < 0) return;
        peer.fireBudget--;
        const muzzle = eye.clone().addScaledVector(dir, .45);
        this.fire(remote, eye, dir, gun, message.spread, muzzle);
        remote.lastShot = gun.suppressed ? remote.lastShot : ctx.time();
        peer.rig.kick();
        ctx.audio.gunshot(gun.id, muzzle, { suppressed: gun.suppressed });
        ctx.fx.muzzle(muzzle, dir, gun.flash, true);
      }
    }

    refillGuestGrenade(peer, supplyId) {
      const drop = this.supplyDrops.get(supplyId);
      if (!drop || drop.id !== peer.id) return;
      this.supplyDrops.delete(supplyId);
      if (this.ctx.time() > drop.expires) return;
      const count = this.api.refillGrenade(peer.frags);
      if (count === peer.frags) return;
      peer.frags = count;
      this.event('grenadeSupply', { life: peer.life }, peer.id);
    }

    deployGuestK9(peer) {
      const k9 = this.match.k9;
      const { actor, id } = peer;
      const opposing = actor.team !== this.player.team;
      const charge = opposing ? this.opposingCharge : k9.charge;
      if (charge < 1 || !this.offline.k9Release(actor, charge)) {
        this.event('k9Hud', { cue: 'denied' }, id);
        return;
      }
      if (opposing) {
        this.opposingCharge = 0;
        this.opposingK9Ready = false;
        this.cueTeam(actor.team, 'deployed');
        k9.hudEvent('enemy_inbound', { owner: actor });
      } else {
        k9.charge = 0;
        k9.wasReady = false;
        k9.hudEvent('deployed', { owner: actor });
      }
    }

    damage(target, amount, source, hit = {}) {
      if (!this.host || !this.match.live || !target.alive) return;
      const { ctx, match, player } = this;
      if (source && source !== target) {
        source._k9hit = target;
        source._k9hitT = ctx.time();
      }
      if ((target === player || target.lanHuman) && ctx.time() - target.spawnT < 1) amount *= .35;
      if (target === player) {
        match._dmg = true;
        player.damage(amount, hit.from || (source !== player ? source?.pos : null) || null, source);
        match._dmg = false;
      } else if (target.lanHuman) {
        target.health = Math.max(0, target.health - amount);
        target.lastHurt = ctx.time();
        target.alive = target.health > 0;
        const seat = this.actorId(target);
        this.peers.get(seat)?.rig.kick();
        this.event('hurt', { hp: target.health, from: (hit.from || source?.pos)?.toArray(), source: this.actorId(source) }, seat);
      } else target.damage(amount, source, hit);
      if (hit.weapon !== 'k9' && source !== target) {
        if (source === player) ctx.hud.hit(hit.head, !target.alive, hit.pellet);
        if (source?.lanHuman) this.event('hit', { head: !!hit.head, killed: !target.alive, pellet: hit.pellet }, this.actorId(source));
      }
      if (!target.alive) this.kill(target, source, hit);
    }

    kill(target, source, hit) {
      if (!this.match.live) return;
      const { player, match, ctx } = this;
      const killer = source && source !== target ? source : null;
      const weapon = hit.weapon || 'ar';
      const head = !!hit.head;
      const ids = { victim: this.actorId(target), killer: this.actorId(killer), weapon, head };
      if (target.isK9) {
        match.k9.destroyed(target, killer, hit);
        if (target.team === player.team) this.cueTeam(1 - target.team, 'enemy_destroyed', { by: ids.killer });
        this.event('kill', { ...ids, k9Team: target.team, medals: ['K9 DESTROYED'] });
        return;
      }
      target.alive = false;
      target.health = 0;
      target.respawnAt = ctx.time() + RESPAWN_SECONDS;
      target.deaths++;
      target.streak = 0;
      const medals = [];
      if (killer) {
        match.k9.onKill(target, killer, hit);
        if (this.teamMatch && killer.lanHuman && !match.k9.unitOf(killer.team)) {
          const k9 = match.k9;
          if (killer.team !== player.team) this.opposingCharge = Math.min(1, this.opposingCharge + this.api.k9Tuning.chargePerKill);
          else k9.charge = Math.min(1, k9.charge + this.api.k9Tuning.chargePerKill);
        }
        if (weapon === 'k9') match.k9.medals(hit, medals);
        else if (head) medals.push('HEADSHOT');
        if (weapon === 'k9' && killer.lanHuman) {
          if (killer.team === player.team) match.k9.hudEvent('takedown', { victim: target, kills: hit.k9?.kills });
          else this.cueTeam(killer.team, 'takedown');
        }
        killer.kills++;
        killer.streak++;
        killer.score += 100 + medals.length * 25;
      }
      match.scores[killer ? killer.team : 1 - target.team]++;
      ctx.hud.killfeed(killer, target, weapon, head);
      const resupply = !!killer && killer.team !== target.team && weapon !== 'k9';
      const remotePose = this.peers.get(ids.victim)?.pose;
      const corpse = target.lanHuman ? this.dropOpponentCorpse(target.team, remotePose, hit) : target.corpses?.at(-1);
      let supplyId;
      if (resupply && killer.lanHuman && this.peers.has(ids.killer)) {
        supplyId = ++this.nextSupplyId;
        this.supplyDrops.set(supplyId, { id: ids.killer, expires: ctx.time() + this.api.corpseLifetime + .25 });
      }
      if (killer === player) {
        this.api.recordElimination(weapon, head);
        if (resupply) match.dropAmmo(corpse);
        ctx.hud.kill(target, medals);
      }
      this.event('kill', {
        ...ids, medals, resupply, supplyId, corpsePose: target === player ? this.localPose() : remotePose,
        dir: hit.dir?.toArray(), point: hit.point?.toArray(), blast: !!hit.blast,
      });
      if (match.hasWinningScore()) this.endRound();
    }

    updateCountdown() {
      const count = Math.max(0, Math.ceil(this.match.countdown));
      if (count === this.lastCount || count > 3) return;
      this.lastCount = count;
      this.ctx.audio.ui(count ? 'countdown' : 'go');
      this.ctx.hud.count(count);
    }

    endRound() {
      this.match.live = false;
      this.match.state = 'ending';
      this.endTime = 1.6;
    }

    tick(dt, realDt) {
      const { match, ctx, player } = this;
      if (!this.host) return;
      if (this.teamMatch) {
        match.k9.update(dt);
        if (match.live && this.opposingHumans && !match.k9.unitOf(1 - player.team)) {
          this.opposingCharge = Math.min(1, this.opposingCharge + dt / this.api.k9Tuning.chargeTime);
          if (this.opposingCharge === 1 && !this.opposingK9Ready) {
            this.opposingK9Ready = true;
            this.cueTeam(1 - player.team, 'ready');
          }
        }
      }
      if (match.state === 'countdown') {
        match.countdown = Math.max(0, match.countdown - realDt);
        this.updateCountdown();
        if (match.countdown === 0) { match.state = 'live'; match.live = true; }
      } else if (match.live) {
        if (match.advanceClock(realDt)) return this.endRound();
        for (const [id, drop] of this.supplyDrops) if (drop.expires < ctx.time()) this.supplyDrops.delete(id);
        const regenBefore = ctx.time() - this.api.healthRegenDelay;
        for (const actor of [player, ...[...this.peers.values()].map(peer => peer.actor)]) {
          if (actor.alive && actor.health < 100 && actor.lastHurt <= regenBefore) {
            actor.health = Math.min(100, actor.health + this.api.healthRegenRate * dt);
          }
        }
        if (!player.alive) {
          ctx.hud.respawnIn(Math.max(0, player.respawnAt - ctx.time()));
          if (player.respawnAt <= ctx.time()) {
            const point = match.pickSpawn(player, false);
            this.spawn({ pos: [point.x, point.y || 0, point.z], yaw: point.yaw });
          }
        }
        for (const peer of this.peers.values()) {
          if (!peer.actor.alive && peer.actor.respawnAt <= ctx.time()) this.spawnOpponent(peer);
        }
      } else if (match.state === 'ending' && (this.endTime -= realDt) <= 0) {
        const scores = match.scores;
        const playerScores = Object.fromEntries([...this.peers.values()].map(({ id, actor }) => [id, actor.score]));
        this.send({ type: 'finish', scores, playerScores });
        this.finish(scores);
      }
    }

    frame(dt) {
      if (!this.active) return;
      for (let i = this.opponentCorpses.length - 1; i >= 0; i--) {
        const corpse = this.opponentCorpses[i];
        if (this.api.advanceCorpse(corpse, dt)) continue;
        this.freeOpponentCorpse(corpse);
        this.opponentCorpses.splice(i, 1);
      }
      if (!this.host) for (const { actor: bot } of this.botReplicas.values()) bot.updateCorpses(dt);
      if (this.host) this.updateHostHit(dt);
      if (this.host || !document.hidden) for (const peer of this.peers.values()) this.renderOpponent(peer, dt);
      if (!this.host && !document.hidden) this.renderReplicas(dt);
      const now = performance.now();
      if (now - this.lastSent < SNAPSHOT_MS) return;
      this.lastSent = now;
      if (this.host) this.publish();
      else if (this.hasState && this.player.alive) this.send({ type: 'pose', pose: this.localPose() });
    }

    actorState(actor) {
      return { hp: actor.health, alive: actor.alive, kills: actor.kills, deaths: actor.deaths, score: actor.score,
        streak: actor.streak, respawn: actor.alive ? 0 : Math.max(0, (actor.respawnAt ?? 0) - this.ctx.time()) };
    }

    publish() {
      const { match, player } = this;
      const players = { [this.seat]: { ...this.actorState(player), pose: this.localPose() } };
      for (const { id, actor, pose } of this.peers.values()) {
        players[id] = { ...this.actorState(actor), pose, pin: this.actorId(actor.k9Pin) };
      }
      this.send({
        type: 'state', state: match.state, time: match.time, overtime: match.overtime, count: match.countdown, scores: match.scores,
        players,
        bots: match.bots.map(bot => ({ ...this.actorState(bot), id: this.actorId(bot), team: bot.team, name: bot.name,
          life: bot.spawnT, pos: bot.pos.toArray(), h: bot.e.h, yaw: bot.state.yaw, pitch: bot.state.pitch,
          aimYaw: bot.aimYaw, stance: bot.state.stance, sprint: bot.state.sprint, airborne: bot.state.airborne,
          reloading: bot.state.reloading, reloadDur: bot.state.reloadDur, engage: bot.state.engage, weapon: bot.def.id })),
        k9: this.teamMatch ? this.k9State() : null,
        chairs: this.api.fireplaceChairs.map(propPose),
        pianoBench: propPose(this.api.pianoBench),
        pianoBooks: propPose(this.api.pianoBooks),
        poolFloats: this.api.poolFloats.map(propPose),
        nades: this.ctx.physics.bodies.filter(body => body.lanId && !body.dead)
          .map(body => [body.lanId, ...body.x, body.fuse, body.fuseTotal, this.actorId(body.owner)]),
      });
    }

    applyState(message) {
      const { match, player, ctx } = this;
      const ours = message.players[this.seat];
      if (!ours) return;
      if (!this.hasState || ours.pose.life !== this.spawnId) this.spawn(ours.pose, ours.pose.life);
      this.hasState = true;
      if (!ours.alive && player.alive) this.hurtLocal(0);
      if (player.alive) player.health = ours.hp;
      if (!ours.alive) ctx.hud.respawnIn(ours.respawn);
      this.applyActorScore(player, ours);
      for (const peer of this.peers.values()) {
        const state = message.players[peer.id];
        if (!state) continue;
        this.applyActorScore(peer.actor, state);
        peer.actor.alive = state.alive;
        peer.actor.health = state.hp;
        this.setOpponentPose(peer, state.pose, peer.life !== state.pose.life);
        peer.life = state.pose.life;
      }
      match.scores = message.scores;
      match.state = message.state;
      match.live = message.state === 'live';
      match.time = message.time;
      match.overtime = message.overtime === true;
      match.countdown = message.count;
      this.updateCountdown();
      this.syncBots(message.bots);
      if (message.k9) this.syncK9(message.k9, ours);
      if (message.chairs) this.api.fireplaceChairs.forEach((chair, index) => {
        const pose = message.chairs[index];
        ctx.physics.setPropPose(chair, pose?.pos, pose?.rotation);
      });
      for (const key of ['pianoBench', 'pianoBooks']) {
        if (!(key in message) || !this.api[key]) continue;
        const pose = message[key];
        ctx.physics.setPropPose(this.api[key], pose?.pos, pose?.rotation);
      }
      if (message.poolFloats) this.api.poolFloats.forEach((body, index) => {
        const pose = message.poolFloats[index];
        ctx.physics.setPropPose(body, pose?.pos, pose?.rotation);
      });
      this.syncGrenades(message.nades);
    }

    applyActorScore(actor, state) {
      actor.kills = state.kills;
      actor.deaths = state.deaths;
      actor.score = state.score;
      actor.streak = state.streak;
    }

    syncBots(states) {
      for (const state of states) {
        let replica = this.botReplicas.get(state.id);
        if (!replica) {
          const bot = this.allocateBot(state.id, state.team, state.name);
          bot.char.root.visible = false;
          replica = { actor: bot, renderPos: this.vector(state.pos), yaw: state.yaw };
          this.botReplicas.set(state.id, replica);
          this.match.actors.splice(this.botReplicas.size, 0, bot);
          this.resetMapBlips();
        }
        const bot = replica.actor;
        if (state.alive && replica.life !== state.life) {
          bot.def = this.api.weapons[state.weapon];
          bot.spawn(...state.pos, state.yaw);
          replica.renderPos.copy(bot.pos);
          replica.yaw = state.yaw;
          replica.life = state.life;
        }
        bot.pos.fromArray(state.pos);
        bot.yaw = state.yaw;
        bot.e.h = state.h;
        Object.assign(bot, { alive: state.alive, health: state.hp, kills: state.kills,
          deaths: state.deaths, score: state.score, streak: state.streak });
        replica.state = state;
      }
    }

    k9State() {
      const k9 = this.match.k9;
      const tuning = this.api.k9Tuning;
      const opposingTeam = 1 - this.player.team;
      const opposingUnit = k9.unitOf(opposingTeam);
      const charge = this.opposingCharge;
      const views = [];
      views[this.player.team] = k9.view;
      views[opposingTeam] = {
        ...k9.view, state: opposingUnit ? 'active' : charge >= 1 ? 'ready' : 'charging',
        charge: opposingUnit ? 0 : charge, hp: opposingUnit ? opposingUnit.health / tuning.hp : 0,
        time: opposingUnit ? Math.max(0, opposingUnit.battery / tuning.battery) : 0, kills: opposingUnit?.kills || 0,
        enemyActive: !!k9.mine,
      };
      const units = k9.pool.flat().filter(unit => unit.inUse).map(unit => {
        const state = unit.rig.state;
        return { id: unit.id, life: unit.lanLife, team: unit.team, owner: this.actorId(unit.owner),
          alive: unit.alive, health: unit.health, kills: unit.kills, phase: unit.phase, unfoldT: unit.unfoldT,
          wreck: unit.wreckT, loop: unit.loopK,
          ...state, lookAt: state.lookAt?.toArray() || null };
      });
      return { views, units };
    }

    hideK9(id, replica) {
      replica.rig.root.visible = false;
      replica.rig.onStep = replica.onStep;
      this.ctx.match.k9.loop(id, null, 0);
      this.k9Replicas.delete(id);
      this.actorIds.delete(replica);
      this.actorsById.delete(id);
    }

    syncK9({ views, units }, ours) {
      const k9 = this.match.k9;
      const live = new Set();
      k9.view = views[this.player.team];
      k9.units.length = 0;
      for (const state of units) {
        live.add(state.id);
        let replica = this.k9Replicas.get(state.id);
        if (!replica || replica.life !== state.life) {
          if (replica) this.hideK9(state.id, replica);
          const team = state.team;
          const rig = this.api.getK9Rig(team, state.id);
          if (!rig) continue;
          const onStep = rig.onStep;
          rig.reset();
          rig.onStep = (leg, pos, strength) => this.offline.k9Sound('step', pos, { leg, strength, gait: rig.gait, id: state.id });
          replica = { id: state.id, life: state.life, team, rig, onStep, pos: this.vector([state.x, state.y, state.z]),
            renderPos: this.vector([state.x, state.y, state.z]), yaw: state.yaw, renderYaw: state.yaw, isK9: true,
            name: 'K9 UNIT', maxHealth: this.api.k9Tuning.hp, mode: null };
          this.k9Replicas.set(state.id, replica);
          this.registerActor(state.id, replica);
        }
        replica.pos.set(state.x, state.y, state.z);
        replica.owner = this.actorsById.get(state.owner);
        Object.assign(replica, { alive: state.alive, health: state.health, phase: state.phase, unfoldT: state.unfoldT, yaw: state.yaw });
        replica.state = state;
        if (state.alive) k9.units.push(replica);
      }
      for (const [id, replica] of this.k9Replicas) if (!live.has(id)) this.hideK9(id, replica);
      const pin = this.k9Replicas.get(ours.pin);
      if (pin && this.player.alive && this.player.k9Pin !== pin) {
        pin.pinning = this.player;
        this.player.k9Pin = pin;
        this.player.knockDown();
        this.player.addShake(.95);
      } else if (!pin) this.player.k9Pin = null;
    }

    renderReplicas(dt) {
      const alpha = 1 - Math.exp(-24 * dt);
      for (const replica of this.botReplicas.values()) {
        const { actor: bot, state } = replica;
        if (!bot.alive) {
          if (!bot.corpses.length) bot.char.root.visible = false;
          continue;
        }
        replica.renderPos.lerp(bot.pos, alpha);
        replica.yaw = this.lerpAngle(replica.yaw, state.yaw, alpha);
        bot.char.update(dt, { ...state, pos: replica.renderPos, yaw: replica.yaw });
      }
      for (const replica of this.k9Replicas.values()) {
        const { rig, state } = replica;
        if (replica.mode !== state.mode) {
          if (state.mode === 'deploy') rig.deploy();
          if (state.mode === 'dead') rig.die(null, 'shot');
          replica.mode = state.mode;
        }
        replica.renderPos.lerp(replica.pos, alpha);
        replica.renderYaw = this.lerpAngle(replica.renderYaw, state.yaw, alpha);
        const { x, y, z } = replica.renderPos;
        const { mode, vx, vy, vz, grounded, pitch, roll, hp, alert, lookAt } = state;
        Object.assign(rig.state, { x, y, z, yaw: replica.renderYaw, mode, vx, vy, vz, grounded, pitch, roll, hp, alert,
          lookAt: lookAt ? this.vector(lookAt) : null });
        rig.root.visible = true;
        const tuning = this.api.k9Tuning;
        rig.setOpacity(Math.min(1, Math.max(0, (tuning.wreckTime - state.wreck) / tuning.fadeTime)));
        rig.update(dt);
        this.match.k9.loop(replica.id, replica.alive ? replica.pos : null, replica.alive ? state.loop : 0);
      }
    }

    lerpAngle(from, to, alpha) {
      const delta = to - from;
      return from + Math.atan2(Math.sin(delta), Math.cos(delta)) * alpha;
    }

    syncGrenades(list = []) {
      const scene = this.ctx.botCtx.scene;
      const live = new Set();
      for (const [id, x, y, z, fuse = 1, fuseTotal = 1, owner] of list) {
        live.add(id);
        let grenade = this.nades.get(id);
        if (!grenade) {
          grenade = { type: 'nade', x: [x, y, z], obj: this.ctx.buildGrenade() };
          this.nades.set(id, grenade);
          scene.add(grenade.obj);
        }
        grenade.x[0] = x;
        grenade.x[1] = y;
        grenade.x[2] = z;
        grenade.fuse = fuse;
        grenade.fuseTotal = fuseTotal;
        grenade.owner = this.actorsById.get(owner) ?? null;
        if (grenade.owner === this.player) this.api.outlineGrenade(grenade.obj);
        grenade.obj.position.set(x, y, z);
        grenade.obj.rotation.x += .28;
      }
      for (const [id, grenade] of this.nades) {
        if (live.has(id)) continue;
        scene.remove(grenade.obj);
        this.nades.delete(id);
      }
    }

    hurtLocal(hp, from, source) {
      if (!this.player.alive || hp >= this.player.health) return;
      this.match._dmg = true;
      this.player.damage(this.player.health - hp, from ? this.vector(from) : null, source);
      this.match._dmg = false;
    }

    applyEvent(message) {
      const { ctx, match, player } = this;
      const actorById = id => this.actorsById.get(id) || null;
      switch (message.kind) {
        case 'hurt':
          this.hurtLocal(message.hp, message.from, actorById(message.source));
          break;
        case 'hit':
          player.stats.hits += message.pellet === 0 || message.pellet === undefined ? 1 : 0;
          ctx.hud.hit(message.head, message.killed, message.pellet);
          break;
        case 'grenadeSupply':
          if (message.life === this.spawnId && player.alive) {
            ctx.arsenal.grenades = Math.min(this.api.grenadeCapacity, ctx.arsenal.grenades + 1);
          }
          break;
        case 'kill': {
          const victim = actorById(message.victim) || (message.k9Team !== undefined
            ? { team: message.k9Team, isK9: true, name: 'K9 UNIT' } : null);
          const killer = actorById(message.killer);
          if (!victim) break;
          const hit = {
            weapon: message.weapon, head: message.head, blast: message.blast,
            dir: message.dir ? this.vector(message.dir) : null, point: message.point ? this.vector(message.point) : null,
          };
          let corpse;
          if (victim.lanHuman) {
            corpse = this.dropOpponentCorpse(victim.team, message.corpsePose, hit);
            victim.alive = false;
          } else if (victim.alive && victim.rigs) {
            victim.die(killer, hit);
            corpse = victim.corpses.at(-1);
          }
          ctx.hud.killfeed(killer, victim, message.weapon, message.head);
          if (killer === player) {
            this.api.recordElimination(message.weapon, message.head);
            if (message.resupply && corpse) {
              corpse.supplyId = message.supplyId;
              match.dropAmmo(corpse);
            }
            ctx.hud.kill(victim, message.medals);
          }
          break;
        }
        case 'shot': {
          const muzzle = this.vector(message.start);
          ctx.fx.tracer(muzzle, this.vector(message.end));
          if (message.owner !== this.seat) {
            const shooter = actorById(message.owner);
            if (shooter && !message.suppressed) shooter.lastShot = ctx.time();
            const peer = this.peers.get(message.owner);
            if (peer) peer.rig.kick();
            else shooter?.char?.kick();
            ctx.audio.gunshot(message.weapon, muzzle, { suppressed: message.suppressed });
            ctx.fx.muzzle(muzzle, this.vector(message.dir), this.api.weapons[message.weapon].flash, true);
          }
          break;
        }
        case 'grenadeBounce':
          ctx.audio.grenadeBounce(this.vector(message.pos));
          break;
        case 'chandelierFall':
          ctx.hotel.chandelier.startFall();
          break;
        case 'tvCrack':
          ctx.hotel.crackTV(message.id, this.vector(message.point));
          break;
        case 'poolFloatPop':
          ctx.hotel.popPoolFloat(message.id, this.vector(message.position));
          break;
        case 'explode':
          this.replaying = true;
          try { this.offline.explode(this.vector(message.pos), actorById(message.owner) || player); }
          finally { this.replaying = false; }
          break;
        case 'glass': {
          const pane = ctx.glass.panes[message.pane];
          if (pane) this.offline.shatter(pane, message.a, message.y, this.vector(message.dir), message.strength);
          break;
        }
        case 'k9Sound':
          this.offline.k9Sound(message.cue, this.vector(message.pos), message.options);
          break;
        case 'k9Hud':
          this.offline.k9Hud(message.cue, { reason: message.reason, by: actorById(message.by) });
          break;
      }
    }
  }

  window.SolsticeLan = LanMatch;
})();
