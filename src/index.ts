// Wires the Gamerfy bot to the music player: read a `/play …` line, resolve it
// with yt-dlp, join the asker's room and play; `/skip`, `/stop`, `/queue`, `/np`.
// Also serves a landing page (and /health) so people can add the bot.
import { Bot } from '@gamerfy/bot';
import { parseCommand } from './commands.js';
import { loadConfig } from './config.js';
import { GuildPlayer, type PlayerSnapshot } from './player.js';
import { Players } from './players.js';
import { FileResolver, YtDlpResolver, type Resolver } from './resolver.js';
import { applyAction, cardOf } from './widget.js';
import { connectWithRetry } from './startup.js';
import { createWebServer } from './web.js';

const config = loadConfig();
const bot = new Bot({ token: config.token, apiUrl: config.apiUrl });
const resolver: Resolver =
  config.testTrack === null
    ? new YtDlpResolver({ ytdlpPath: config.ytdlpPath, ffmpegPath: config.ffmpegPath, extraArgs: config.ytdlpExtraArgs })
    : new FileResolver(config.testTrack);
if (config.testTrack !== null) console.log(`[music] MUSIC_TEST_TRACK: toda faixa é ${config.testTrack} (só para a prova)`);

/**
 * Where the asker is. The cache first; when it says "no room", the server
 * again — `fetchGuild` makes the backend check who is in the rooms against
 * LiveKit itself before answering, so a join whose webhook was lost does not
 * make the bot tell somebody sitting in a room to "join one first".
 */
async function voiceChannelOf(guildId: string, userId: string): Promise<string | null> {
  const cached = bot.voiceChannelOf(guildId, userId);
  if (cached !== null) return cached;
  try {
    await bot.fetchGuild(guildId);
  } catch (error) {
    console.error('[music] não consegui reler o servidor', error instanceof Error ? error.message : error);
  }
  return bot.voiceChannelOf(guildId, userId);
}

async function say(channelId: string, text: string): Promise<void> {
  try {
    await bot.messages.send(channelId, text);
  } catch (error) {
    console.error('[music] não consegui responder no canal', error);
  }
}

const players = new Players(
  (guildId) =>
    new GuildPlayer(guildId, {
      resolver,
      maxQueue: config.maxQueue,
      join: (channelId) => bot.voice.join(channelId),
      voiceChannelOf: (userId) => voiceChannelOf(guildId, userId),
      roomNameOf: (channelId) => bot.guilds.get(guildId)?.channels.get(channelId)?.name ?? null,
      publishWidget: (snapshot) => {
        publishWidget(guildId, snapshot);
      },
      say,
    }),
);

/**
 * The card at the foot of the members column (SDK `setWidget`). What it draws
 * and what a press does both live in `widget.ts`, over one list of actions, so
 * the two halves cannot drift apart again.
 *
 * Failures are logged once and swallowed. The widget is decoration over the
 * music: a backend that refuses it must not end a song, and the next change
 * publishes again anyway.
 */
function publishWidget(guildId: string, snapshot: PlayerSnapshot): void {
  const card = cardOf(snapshot);
  if (card === null) {
    bot.clearWidget(guildId).catch((error: unknown) => {
      console.error('[music] não consegui tirar o widget', error);
    });
    return;
  }
  bot.setWidget(guildId, card).catch((error: unknown) => {
    console.error('[music] não consegui publicar o widget', error);
  });
}

/*
 * A press on the card. The gateway has already checked that the person was in
 * the voice room the card named, so there is nothing to check again here —
 * this is the same command the person could have typed, arriving as a button.
 */
bot.on('widgetAction', (event) => {
  applyAction(players.of(event.guildId), event.action);
});

bot.on('message', async (message) => {
  // `content` is null when the bot may not read the channel and was not
  // mentioned — nothing to parse then.
  if (message.content === null) return;
  const command = parseCommand(message.content, config.prefix);
  if (command === null) return;

  const player = players.of(message.guildId);
  const requester = { id: message.author.id, username: message.author.username };
  switch (command.name) {
    case 'play':
      await player.play(command.query, requester, message.channelId);
      return;
    case 'skip':
      await player.skip(message.channelId);
      return;
    case 'stop':
      await player.stop(message.channelId);
      return;
    case 'queue':
      await player.showQueue(message.channelId);
      return;
    case 'nowplaying':
      await player.nowPlaying(message.channelId);
      return;
  }
});

bot.on('error', (error) => console.error('[music]', error.message));

const web = createWebServer({
  botName: () => bot.user?.username ?? null,
  installUrl: config.installUrl,
  prefix: config.prefix,
});
web.listen(config.port, () => console.log(`[music] página no ar na porta ${String(config.port)}`));

// A fatal gateway close does not reconnect (REPLACED by another connection of
// the same token, a rotated/invalid token, a retired bot). The SDK stops, but
// this process would stay alive on its web server — deaf to commands, and with
// a voice-state cache that never refreshes. Exit so the container restarts
// clean: a fresh `ready` re-reads every guild's current voice state.
let shuttingDown = false;
bot.on('disconnect', (event) => {
  // Our own `destroy()` on SIGTERM closes with 1000 and no reconnect: that is
  // the program leaving, not the gateway giving up on it.
  if (shuttingDown) return;
  if (event.willReconnect) {
    // One line per drop, with the code: the story of a bot that "went offline"
    // starts here (4900/4901/4902 are the SDK giving up on a dead connection;
    // 1001 a deploy; 1006 the network). Silent, a container's log said nothing
    // about a quarter of an hour offline (19/09).
    console.error(`[music] o gateway caiu (code ${String(event.code)}); reconectando`);
    return;
  }
  console.error(`[music] o gateway fechou de vez (code ${String(event.code)}); saindo para o container reiniciar limpo`);
  web.close();
  void bot.destroy().finally(() => process.exit(1));
});
bot.on('resumed', (event) => console.log(`[music] sessão retomada (${String(event.replayed)} evento(s) repostos)`));
bot.on('ready', (user) => console.log(`[music] ready como ${user.username} em ${String(bot.guilds.size)} servidor(es)`));

// Kept trying until the gateway answers — a deploy's maintenance window must
// not turn into a crash loop (startup.ts). Only a refusal with no way back exits.
try {
  await connectWithRetry(bot);
} catch (error) {
  console.error('[music] o gateway recusou este bot de vez; saindo', error instanceof Error ? error.message : error);
  web.close();
  process.exit(1);
}
console.log(`[music] no ar como ${bot.user?.username ?? 'bot'}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    shuttingDown = true;
    console.log(`[music] ${signal}: saindo…`);
    web.close();
    void bot.destroy().then(() => process.exit(0));
  });
}
