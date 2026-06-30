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

const commands = [
    new SlashCommandBuilder()
        .setName('play')
        .setDescription('Reproduce una cancion de Spotify o SoundCloud en la cola')
        .addStringOption(option =>
            option.setName('url')
                .setDescription('Link de Spotify o SoundCloud')
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
    let lastError;

    for (let i = 0; i < attempts; i++) {
        try {
            return await play.stream(url, { discordPlayerCompatibility: true });
        } catch (error) {
            lastError = error;
            const message = String(error?.message || error);

            if (!message.includes('429')) {
                throw error;
            }

            await wait(1500 * (i + 1));
        }
    }

    throw lastError;
}

function buildArtistString(artists) {
    return (artists || [])
        .map(artist => artist?.name)
        .filter(Boolean)
        .join(' ');
}

function buildQueryFromTrack(track) {
    return [track?.name, buildArtistString(track?.artists)]
        .filter(Boolean)
        .join(' ')
        .trim();
}

function trackToSong(track, requestedBy) {
    return {
        title: track.name,
        url: track.url,
        duration: track.durationInSec || 0,
        requestedBy
    };
}

async function searchSoundCloudTrack(query, requestedBy) {
    const results = await play.search(query, { source: { soundcloud: 'tracks' }, limit: 1 });
    const track = results?.[0];

    if (!track) {
        throw new Error(`No encontre una coincidencia en SoundCloud para: ${query}`);
    }

    return trackToSong(track, requestedBy);
}

async function resolveSoundCloudSongs(url, requestedBy) {
    const sourceType = await play.validate(url);

    if (sourceType === 'so_track') {
        const track = await play.soundcloud(url);
        return [trackToSong(track, requestedBy)];
    }

    if (sourceType === 'so_playlist') {
        const playlist = await play.soundcloud(url);
        return playlist.tracks.map(track => trackToSong(track, requestedBy));
    }

    if (sourceType === 'sp_track') {
        const track = await play.spotify(url);
        return [await searchSoundCloudTrack(buildQueryFromTrack(track), requestedBy)];
    }

    if (sourceType === 'sp_playlist' || sourceType === 'sp_album') {
        const collection = await play.spotify(url);
        const tracks = collection.tracks || [];
        const songs = [];

        for (const track of tracks.slice(0, 50)) {
            const query = buildQueryFromTrack(track);
            if (!query) continue;

            try {
                songs.push(await searchSoundCloudTrack(query, requestedBy));
            } catch (error) {
                console.warn(`No encontre coincidencia para "${query}":`, error.message);
            }
        }

        if (songs.length === 0) {
            throw new Error('No pude convertir ese Spotify a una cancion reproducible.');
        }

        return songs;
    }

    throw new Error('Pasa un link valido de Spotify o SoundCloud.');
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

    const songs = await resolveSoundCloudSongs(url, requestedBy);
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
    const soundcloudClientId = process.env.SC_CLIENT_ID || process.env.SOUNDCLOUD_CLIENT_ID || await play.getFreeClientID();

    await play.setToken({
        soundcloud: {
            client_id: soundcloudClientId
        }
    });

    client.once('ready', async () => {
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
                return interaction.editReply(`Agregada: **${songs[0].title}**`);
            }

            return interaction.editReply(`Agregadas **${songs.length}** canciones de la playlist.`);
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
