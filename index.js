const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const {
    AudioPlayerStatus,
    NoSubscriberBehavior,
    StreamType,
    VoiceConnectionStatus,
    createAudioPlayer,
    createAudioResource,
    entersState,
    getVoiceConnection,
    joinVoiceChannel
} = require('@discordjs/voice');
const path = require('node:path');
const play = require('play-dl');
require('dotenv').config();

const ffmpegPath = require('ffmpeg-static');

if (ffmpegPath) {
    process.env.FFMPEG_PATH = ffmpegPath;
    process.env.PATH = `${path.dirname(ffmpegPath)};${process.env.PATH || ''}`;
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates
    ]
});

const queues = new Map();
const spotifyTokenState = {
    accessToken: null,
    expiresAt: 0
};

const commands = [
    new SlashCommandBuilder()
        .setName('play')
        .setDescription('Reproduce una cancion de Spotify en la cola')
        .addStringOption(option =>
            option.setName('url')
                .setDescription('Link de Spotify')
                .setRequired(true)
        ),
    new SlashCommandBuilder()
        .setName('pause')
        .setDescription('Pausa la musica'),
    new SlashCommandBuilder()
        .setName('resume')
        .setDescription('Reanuda la musica'),
    new SlashCommandBuilder()
        .setName('skip')
        .setDescription('Salta la cancion actual'),
    new SlashCommandBuilder()
        .setName('stop')
        .setDescription('Detiene la musica y limpia la cola'),
    new SlashCommandBuilder()
        .setName('queue')
        .setDescription('Muestra la cola actual')
].map(command => command.toJSON());

function getQueue(guildId) {
    if (!queues.has(guildId)) {
        queues.set(guildId, {
            songs: [],
            player: createAudioPlayer({
                behaviors: {
                    noSubscriber: NoSubscriberBehavior.Pause
                }
            }),
            connection: null,
            playing: false
        });
    }

    return queues.get(guildId);
}

async function ensureConnection(guild) {
    const existing = getVoiceConnection(guild.id);

    if (existing) return existing;

    const channel = await guild.channels.fetch(process.env.VOICE_CHANNEL_ID).catch(() => null);

    if (!channel) throw new Error('Canal no encontrado');
    if (!channel.isVoiceBased()) throw new Error('El canal no es de voz');

    const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false
    });

    connection.on('error', error => {
        console.error('Error de voz:', error);
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
            await entersState(connection, VoiceConnectionStatus.Signalling, 5_000);
        } catch {
            setTimeout(() => ensureConnection(guild).catch(() => null), 5_000);
        }
    });

    return connection;
}

function formatDuration(seconds) {
    if (!seconds || Number.isNaN(seconds)) return 'En vivo';

    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    return [hrs > 0 ? String(hrs).padStart(2, '0') : null, String(mins).padStart(2, '0'), String(secs).padStart(2, '0')]
        .filter(Boolean)
        .join(':');
}

function mapStreamType(type) {
    if (type === StreamType.Opus || type === 'opus') return StreamType.Opus;
    if (type === StreamType.OggOpus || type === 'ogg/opus') return StreamType.OggOpus;
    return StreamType.Arbitrary;
}

async function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function getStreamWithRetry(url, attempts = 3) {
    for (let i = 0; i < attempts; i++) {
        try {
            return { stream: url, type: StreamType.Arbitrary };
        } catch (error) {
            const message = String(error?.message || error);

            if (!message.includes('429')) {
                throw error;
            }

            await wait(1500 * (i + 1));
        }
    }

    throw new Error('No pude preparar el audio de Spotify.');
}

function parseSpotifyUrl(url) {
    const input = String(url || '').trim();
    const match =
        input.match(/^https?:\/\/open\.spotify\.com\/(?:[a-z]{2,10}(?:-[a-z]{2,10})*\/)?(track|playlist|album)\/([A-Za-z0-9]+)/i) ||
        input.match(/^spotify:(track|playlist|album):([A-Za-z0-9]+)/i);

    if (!match) return null;

    return {
        type: match[1].toLowerCase(),
        id: match[2]
    };
}

async function getSpotifyAccessToken() {
    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        throw new Error('Faltan SPOTIFY_CLIENT_ID o SPOTIFY_CLIENT_SECRET en Railway.');
    }

    if (spotifyTokenState.accessToken && Date.now() < spotifyTokenState.expiresAt) {
        return spotifyTokenState.accessToken;
    }

    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const response = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
            Authorization: `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({ grant_type: 'client_credentials' })
    });

    if (!response.ok) {
        throw new Error(`No pude autenticar Spotify (${response.status})`);
    }

    const data = await response.json();
    spotifyTokenState.accessToken = data.access_token;
    spotifyTokenState.expiresAt = Date.now() + Math.max(60, (data.expires_in || 3600) - 60) * 1000;
    return spotifyTokenState.accessToken;
}

async function spotifyApi(pathname) {
    const token = await getSpotifyAccessToken();
    const response = await fetch(`https://api.spotify.com/v1${pathname}`, {
        headers: {
            Authorization: `Bearer ${token}`
        }
    });

    if (!response.ok) {
        const details = await response.text().catch(() => '');
        const suffix = details ? `: ${details.slice(0, 180)}` : '';
        throw new Error(`Spotify API fallo (${response.status})${suffix}`);
    }

    return response.json();
}

function buildArtists(track) {
    return (track.artists || []).map(artist => artist.name).filter(Boolean).join(', ');
}

function formatDurationMs(ms) {
    const totalSeconds = Math.max(0, Math.floor((ms || 0) / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = String(totalSeconds % 60).padStart(2, '0');
    return `${minutes}:${seconds}`;
}

function trackToSong(track, requestedBy) {
    const previewUrl = track.preview_url || track.previewURL || null;

    return {
        title: `${track.name}${buildArtists(track) ? ` - ${buildArtists(track)}` : ''}`,
        url: previewUrl,
        previewUrl,
        duration: track.duration_ms || 30000,
        requestedBy
    };
}

async function resolveSpotifySongs(url, requestedBy) {
    const parsed = parseSpotifyUrl(url);

    if (!parsed) {
        throw new Error('Pasa un link valido de Spotify.');
    }

    if (parsed.type === 'track') {
        const track = await spotifyApi(`/tracks/${parsed.id}`);

        if (!track.preview_url) {
            throw new Error('Ese track de Spotify no tiene preview y no se puede reproducir.');
        }

        return [trackToSong(track, requestedBy)];
    }

    if (parsed.type === 'playlist') {
        const songs = [];
        let offset = 0;

        while (true) {
            const data = await spotifyApi(`/playlists/${parsed.id}/tracks?limit=100&offset=${offset}`);

            for (const item of data.items || []) {
                const track = item?.track;
                if (!track || !track.preview_url) continue;
                songs.push(trackToSong(track, requestedBy));
            }

            if (!data.next) break;
            offset += data.items?.length || 0;
        }

        if (!songs.length) {
            throw new Error('Esa playlist no tiene previews reproducibles.');
        }

        return songs;
    }

    if (parsed.type === 'album') {
        const songs = [];
        let offset = 0;

        while (true) {
            const data = await spotifyApi(`/albums/${parsed.id}/tracks?limit=50&offset=${offset}`);

            for (const track of data.items || []) {
                if (!track.preview_url) continue;
                songs.push(trackToSong(track, requestedBy));
            }

            if (!data.next) break;
            offset += data.items?.length || 0;
        }

        if (!songs.length) {
            throw new Error('Ese album no tiene previews reproducibles.');
        }

        return songs;
    }

    throw new Error('Pasa un link valido de Spotify.');
}

async function playNext(guildId) {
    const queue = getQueue(guildId);
    const song = queue.songs[0];

    if (!song) {
        queue.playing = false;
        return;
    }

    try {
        const stream = await getStreamWithRetry(song.url);
        const resource = createAudioResource(stream.stream, {
            inputType: mapStreamType(stream.type),
            metadata: song
        });

        queue.player.play(resource);
        queue.playing = true;
        queue.connection.subscribe(queue.player);
    } catch (error) {
        console.error('Error creando el stream:', error);
        queue.songs.shift();
        queue.playing = false;
        throw error;
    }
}

async function addSong(guild, url, requestedBy) {
    const queue = getQueue(guild.id);

    const songs = await resolveSpotifySongs(url, requestedBy);
    queue.songs.push(...songs);

    if (!queue.connection) {
        queue.connection = await ensureConnection(guild);
    }

    if (!queue.playing) {
        await playNext(guild.id);
    }

    return songs;
}

async function bootstrap() {
    client.once('clientReady', async () => {
        console.log(`Bot conectado como ${client.user.tag}`);

        const guild = await client.guilds.fetch(process.env.GUILD_ID).catch(() => null);

        if (!guild) return console.log('Servidor no encontrado');

        const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

        await rest.put(Routes.applicationGuildCommands(client.user.id, process.env.GUILD_ID), { body: commands });

        try {
            const connection = await ensureConnection(guild);
            const queue = getQueue(guild.id);

            queue.connection = connection;
            connection.subscribe(queue.player);

            queue.player.on(AudioPlayerStatus.Idle, async () => {
                const current = queue.songs.shift();
                if (current) {
                    console.log(`Termino: ${current.title}`);
                }

                if (queue.songs.length > 0) {
                    await playNext(guild.id).catch(error => console.error(error));
                } else {
                    queue.playing = false;
                }
            });

            queue.player.on('error', error => {
                console.error('Error del reproductor:', error);
                queue.songs.shift();
                playNext(guild.id).catch(err => console.error(err));
            });

            console.log('Conectado al canal de voz');
        } catch (error) {
            console.log(error.message);
        }
    });

    client.login(process.env.TOKEN);
}

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.guildId !== process.env.GUILD_ID) {
        return interaction.reply({ content: 'Este bot solo responde en el servidor configurado.', ephemeral: true });
    }

    const guild = await client.guilds.fetch(process.env.GUILD_ID).catch(() => null);

    if (!guild) {
        return interaction.reply({ content: 'Servidor no encontrado.', ephemeral: true });
    }

    const queue = getQueue(guild.id);

    try {
        if (interaction.commandName === 'play') {
            const url = interaction.options.getString('url', true);

            await interaction.deferReply();
            const songs = await addSong(guild, url, interaction.user.tag);

            if (songs.length === 1) {
                return interaction.editReply(`Agregada: **${songs[0].title}** (${formatDurationMs(songs[0].duration)} preview)`);
            }

            return interaction.editReply(`Agregadas **${songs.length}** canciones de Spotify con preview.`);
        }

        if (interaction.commandName === 'pause') {
            if (queue.player.state.status !== AudioPlayerStatus.Playing) {
                return interaction.reply({ content: 'No hay musica sonando.', ephemeral: true });
            }

            queue.player.pause();
            return interaction.reply('Musica pausada.');
        }

        if (interaction.commandName === 'resume') {
            if (queue.player.state.status !== AudioPlayerStatus.Paused) {
                return interaction.reply({ content: 'La musica no esta pausada.', ephemeral: true });
            }

            queue.player.unpause();
            return interaction.reply('Musica reanudada.');
        }

        if (interaction.commandName === 'skip') {
            if (queue.songs.length === 0) {
                return interaction.reply({ content: 'No hay canciones en cola.', ephemeral: true });
            }

            queue.player.stop(true);
            return interaction.reply('Cancion saltada.');
        }

        if (interaction.commandName === 'stop') {
            queue.songs = [];
            queue.playing = false;
            queue.player.stop(true);
            return interaction.reply('Musica detenida y cola limpiada.');
        }

        if (interaction.commandName === 'queue') {
            if (queue.songs.length === 0) {
                return interaction.reply({ content: 'La cola esta vacia.', ephemeral: true });
            }

            const list = queue.songs.slice(0, 10).map((song, index) => `${index + 1}. ${song.title}`).join('\n');
            return interaction.reply(`Cola actual:\n${list}`);
        }
    } catch (error) {
        console.error(error);
        const details = String(error?.message || error).slice(0, 180);

        if (interaction.deferred || interaction.replied) {
            return interaction.editReply(`No pude reproducir esa cancion: ${details}`);
        }

        return interaction.reply({ content: `No pude reproducir esa cancion: ${details}`, ephemeral: true });
    }
});

bootstrap().catch(error => {
    console.error('Error al iniciar el bot:', error);
    process.exitCode = 1;
});
