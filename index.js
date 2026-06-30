const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const {
    AudioPlayerStatus,
    NoSubscriberBehavior,
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
        .setDescription('Busca y reproduce musica por nombre')
        .addStringOption(option =>
            option.setName('query')
                .setDescription('Nombre de la cancion o link de YouTube')
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

async function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function configurePlayDl() {
    const youtubeCookie = process.env.YOUTUBE_COOKIE;

    if (youtubeCookie) {
        await play.setToken({
            youtube: {
                cookie: youtubeCookie
            }
        });
        console.log('Cookie de YouTube cargada.');
    }
}

function parseYoutubeUrl(url) {
    const input = String(url || '').trim();
    const match = input.match(/^https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be|music\.youtube\.com)\/.+/i);
    return match ? input : null;
}

async function searchYoutube(query) {
    const results = await play.search(query, {
        limit: 1,
        source: { youtube: 'video' }
    });

    if (!results || results.length === 0) {
        throw new Error('No encontre una cancion en YouTube para ese enlace.');
    }

    const result = results[0];
    const url = result?.url || result?.link || (result?.id ? `https://www.youtube.com/watch?v=${result.id}` : null);

    if (!url) {
        throw new Error('No pude obtener la URL de esa cancion.');
    }

    return {
        ...result,
        url
    };
}

async function getStreamWithRetry(url, attempts = 3) {
    for (let i = 0; i < attempts; i++) {
        try {
            return await play.stream(url, {
                discordPlayerCompatibility: true
            });
        } catch (error) {
            const message = String(error?.message || error);

            if (!message.includes('429')) {
                throw error;
            }

            await wait(1500 * (i + 1));
        }
    }

    throw new Error('No pude preparar el audio.');
}

function normalizeTitle(title) {
    return String(title || '').replace(/\s+/g, ' ').trim();
}

async function resolveMusic(url, requestedBy) {
    const youtubeUrl = parseYoutubeUrl(url);
    if (youtubeUrl) {
        const info = await play.video_basic_info(youtubeUrl);
        return [{
            title: normalizeTitle(info?.video_details?.title || 'Cancion de YouTube'),
            url: youtubeUrl,
            duration: info?.video_details?.durationInSec || 0,
            requestedBy
        }];
    }

    const search = await searchYoutube(url);
    return [{
        title: normalizeTitle(search.title || 'Cancion encontrada'),
        url: search.url,
        duration: search.durationInSec || 0,
        requestedBy
    }];
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
            inputType: stream.type,
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

    const songs = await resolveMusic(url, requestedBy);
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
    await configurePlayDl();

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
            const query = interaction.options.getString('query', true);

            await interaction.deferReply();
            const songs = await addSong(guild, query, interaction.user.tag);

            return interaction.editReply(`Agregada: **${songs[0].title}**${songs[0].duration ? ` (${formatDuration(songs[0].duration)})` : ''}`);
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
