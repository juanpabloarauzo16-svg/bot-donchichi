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
const play = require('play-dl');
require('dotenv').config();

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
        .setDescription('Reproduce una cancion de YouTube en la cola')
        .addStringOption(option =>
            option.setName('url')
                .setDescription('Link de YouTube')
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

async function playNext(guildId) {
    const queue = getQueue(guildId);
    const song = queue.songs[0];

    if (!song) {
        queue.playing = false;
        return;
    }

    const stream = await play.stream(song.url);
    const resource = createAudioResource(stream.stream, {
        inputType: stream.type === 'opus' ? StreamType.Opus : stream.type,
        metadata: song
    });

    queue.player.play(resource);
    queue.playing = true;
    queue.connection.subscribe(queue.player);
}

async function addSong(guild, url, requestedBy) {
    const queue = getQueue(guild.id);
    const info = await play.video_basic_info(url);

    const song = {
        title: info.video_details.title,
        url: info.video_details.url,
        duration: info.video_details.durationInSec,
        requestedBy
    };

    queue.songs.push(song);

    if (!queue.connection) {
        queue.connection = await ensureConnection(guild);
    }

    if (!queue.playing) {
        await playNext(guild.id);
    }

    return song;
}

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
            if (!play.yt_validate(url)) {
                return interaction.reply({ content: 'Pasa un link valido de YouTube.', ephemeral: true });
            }

            await interaction.deferReply();
            const song = await addSong(guild, url, interaction.user.tag);

            return interaction.editReply(`Agregada: **${song.title}** \`${formatDuration(song.duration)}\``);
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
        if (interaction.deferred || interaction.replied) {
            return interaction.editReply('Ocurrio un error reproduciendo la musica.');
        }

        return interaction.reply({ content: 'Ocurrio un error reproduciendo la musica.', ephemeral: true });
    }
});

client.login(process.env.TOKEN);
