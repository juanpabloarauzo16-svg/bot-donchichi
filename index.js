const { Client, GatewayIntentBits } = require('discord.js');
const { joinVoiceChannel } = require('@discordjs/voice');
require('dotenv').config();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates
    ]
});

client.once('ready', async () => {
    console.log(`Bot conectado como ${client.user.tag}`);

    const guild = client.guilds.cache.get(process.env.GUILD_ID);

    if (!guild) return console.log("Servidor no encontrado");

    const channel = guild.channels.cache.get(process.env.VOICE_CHANNEL_ID);

    if (!channel) return console.log("Canal no encontrado");

    joinVoiceChannel({
        channelId: channel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false
    });

    console.log("Conectado al canal de voz");
});

client.login(process.env.TOKEN);