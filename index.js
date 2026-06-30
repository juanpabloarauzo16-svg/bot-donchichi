const { Client, GatewayIntentBits, ActivityType } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const play = require('play-dl');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates
    ]
});

// Crear reproductor de audio global
const player = createAudioPlayer();
let connection = null;

// Manejar errores en el reproductor de audio para evitar que el bot se caiga
player.on('error', error => {
    console.error('Error en el reproductor de audio:', error);
});

// Función para parsear cookies en formato Netscape a formato de cabecera HTTP
function getCookieString(content) {
    content = content.trim();
    // Detectar si el archivo está en formato Netscape (comentarios o tabulaciones)
    if (content.includes('\t') || content.includes('#')) {
        console.log("Parseando cookies.txt detectado en formato Netscape...");
        const lines = content.split(/\r?\n/);
        const cookiePairs = [];
        for (let line of lines) {
            line = line.trim();
            if (!line || line.startsWith('#')) continue;
            const parts = line.split(/\s+/);
            if (parts.length >= 7) {
                const name = parts[5];
                const value = parts[6];
                cookiePairs.push(`${name}=${value}`);
            }
        }
        return cookiePairs.join('; ');
    }
    // Si ya es una sola línea estándar
    return content;
}

// Cargar cookies de YouTube si existen para evitar bloqueo de bots en Railway
const cookiesPath = path.join(__dirname, 'cookies.txt');
if (fs.existsSync(cookiesPath)) {
    try {
        const rawContent = fs.readFileSync(cookiesPath, 'utf8');
        const parsedCookies = getCookieString(rawContent);
        
        play.setToken({
            youtube: {
                cookie: parsedCookies
            }
        });
        console.log("✅ Archivo cookies.txt cargado y formateado con éxito para play-dl.");
    } catch (err) {
        console.error("❌ Error al cargar/formatear cookies.txt:", err);
    }
} else {
    console.log("⚠️ No se encontró cookies.txt. Las peticiones a YouTube en Railway podrían fallar con error de bot.");
}

// Usar clientReady en lugar de ready para evitar advertencias de deprecación
client.once('clientReady', async () => {
    console.log(`Bot conectado como ${client.user.tag}`);

    // Configurar actividad del bot
    client.user.setActivity('música en 24/7', { type: ActivityType.Listening });

    const guild = client.guilds.cache.get(process.env.GUILD_ID);
    if (!guild) return console.log("Servidor no encontrado");

    const channel = guild.channels.cache.get(process.env.VOICE_CHANNEL_ID);
    if (!channel) return console.log("Canal no encontrado");

    try {
        // Unirse al canal de voz 24/7
        connection = joinVoiceChannel({
            channelId: channel.id,
            guildId: guild.id,
            adapterCreator: guild.voiceAdapterCreator,
            selfDeaf: false
        });

        // Registrar manejadores de estado y errores para la conexión de voz
        connection.on('error', error => {
            console.error("Error en la conexión de voz:", error);
        });

        connection.on('stateChange', (oldState, newState) => {
            console.log(`Conexión de voz cambió de ${oldState.status} a ${newState.status}`);
        });

        // Suscribir la conexión al reproductor de audio
        connection.subscribe(player);
        console.log("Conectado y suscrito al canal de voz 24/7");
    } catch (voiceError) {
        console.error("Error al intentar conectarse al canal de voz inicial:", voiceError);
    }

    // Registrar comandos de barra (Slash Commands) de forma global
    const commands = [
        {
            name: 'play',
            description: 'Reproduce música de YouTube (enlace o búsqueda)',
            options: [
                {
                    name: 'cancion',
                    type: 3, // String
                    description: 'Nombre de la canción o link de YouTube',
                    required: true
                }
            ]
        },
        {
            name: 'pause',
            description: 'Pausa la música actual'
        },
        {
            name: 'resume',
            description: 'Reanuda la música pausada'
        },
        {
            name: 'stop',
            description: 'Detiene la música y la quita'
        }
    ];

    try {
        console.log("Registrando comandos en Discord...");
        await client.application.commands.set(commands);
        console.log("Comandos registrados exitosamente.");
    } catch (err) {
        console.error("Error al registrar comandos:", err);
    }
});

// Escuchar comandos de barra
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;

    if (commandName === 'play') {
        await interaction.deferReply();
        
        // Obtener el query usando tanto 'cancion' como 'query' por si Discord tiene en caché comandos antiguos
        const query = interaction.options.getString('cancion') || interaction.options.getString('query');
        
        console.log('--- Nueva petición /play ---');
        console.log('Query recibido:', query);
        console.log('Todas las opciones recibidas:', JSON.stringify(interaction.options.data, null, 2));

        if (!query || typeof query !== 'string' || query.trim() === '') {
            return interaction.editReply('❌ Por favor, proporciona un enlace o término de búsqueda válido.');
        }

        try {
            let stream;
            let title = "";

            const cleanQuery = query.trim();
            // Validar de forma asíncrona la consulta usando play.validate
            const validation = await play.validate(cleanQuery);
            console.log('Tipo de validación de play-dl:', validation);

            if (validation === 'yt_video' || validation === 'yt_playlist') {
                // Obtener el stream directamente usando play.stream (más estable)
                stream = await play.stream(cleanQuery);
                try {
                    const videoInfo = await play.video_info(cleanQuery);
                    title = videoInfo.video_details.title;
                } catch (e) {
                    title = "Música de YouTube";
                }
            } else {
                // Si no es URL válida de YouTube, buscar por término
                const searchResults = await play.search(cleanQuery, { limit: 1 });
                if (searchResults.length === 0) {
                    return interaction.editReply('❌ No se encontró ninguna canción con ese nombre.');
                }
                title = searchResults[0].title;
                stream = await play.stream(searchResults[0].url);
            }

            const resource = createAudioResource(stream.stream, {
                inputType: stream.type
            });

            player.play(resource);
            await interaction.editReply(`🎶 Reproduciendo: **${title}**`);
        } catch (error) {
            console.error('Error al intentar reproducir la canción:', error);
            await interaction.editReply('❌ Hubo un error al intentar reproducir la canción: ' + error.message);
        }
    }

    if (commandName === 'pause') {
        if (player.state.status === AudioPlayerStatus.Playing) {
            player.pause();
            await interaction.reply('⏸️ Música pausada.');
        } else {
            await interaction.reply('⚠️ No hay ninguna canción reproduciéndose actualmente.');
        }
    }

    if (commandName === 'resume') {
        if (player.state.status === AudioPlayerStatus.Paused) {
            player.unpause();
            await interaction.reply('▶️ Reanudando la música.');
        } else {
            await interaction.reply('⚠️ La música no está pausada.');
        }
    }

    if (commandName === 'stop') {
        if (player.state.status !== AudioPlayerStatus.Idle) {
            player.stop();
            await interaction.reply('⏹️ Reproducción detenida y silenciada.');
        } else {
            await interaction.reply('⚠️ No hay música reproduciéndose en este momento.');
        }
    }
});

client.login(process.env.TOKEN);
