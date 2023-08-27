import dotnev from 'dotenv'
import fastify from 'fastify';
import fastifyCors from '@fastify/cors'
import fastifyIO from 'fastify-socket.io'
import Redis from 'ioredis'
import closeWithGrace from 'close-with-grace';
import { randomUUID } from 'crypto';

dotnev.config();

const PORT = parseInt(process.env.PORT || '3001',10)
const HOST = process.env.HOST || '0.0.0.0' //docker doesnt understand localhost
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:3000'
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;

const CONNECTION_COUNT_KEY = "chat:connection-count";
const CONNECTION_COUNT_UPDATED_CHANNEL = "chat:connection-count-updated";
const NEW_MESSAGE_CHANNEL = "chat:new-message";
const NEW_MESSAGE_KEY = "chat:messages";

if(!UPSTASH_REDIS_REST_URL){
    console.error('UPSTASH_REDIS_REST_URL must be defined');
    process.exit(1);
}

const publisher = new Redis(UPSTASH_REDIS_REST_URL);
const subscriber = new Redis(UPSTASH_REDIS_REST_URL);

let connectedClients = 0;

async function buildServer() {
    const app = fastify();

    await app.register(fastifyCors, {
        origin: CORS_ORIGIN
    })

    //register our websocket plugin
    await app.register(fastifyIO)

    const currentCount = await publisher.get(CONNECTION_COUNT_KEY);
    if(!currentCount) {
        await publisher.set(CONNECTION_COUNT_KEY, '0');
    }

    app.io.on('connection', async (io) => {
        console.log('Client connected');
        connectedClients++;
        const newCount = await publisher.incr(CONNECTION_COUNT_KEY);
        await publisher.publish(CONNECTION_COUNT_UPDATED_CHANNEL, String(newCount));

        //receive message from client
        io.on(NEW_MESSAGE_CHANNEL, async ({message}) => {
            //publish to redis for others to subscribe to that message
            //toString because message is a buffer
            await publisher.publish(NEW_MESSAGE_CHANNEL, String(message));
        })

        io.on('disconnect', async() => {
            console.log('Client disconnected');
            connectedClients--;
            const newCount = await publisher.decr(CONNECTION_COUNT_KEY);
            await publisher.publish(CONNECTION_COUNT_UPDATED_CHANNEL, String(newCount));
        })
    })

    //subscribe to the channel
    subscriber.subscribe(CONNECTION_COUNT_UPDATED_CHANNEL, (err, count) => {
        if(err) {
            console.error(`Error subscribing to ${CONNECTION_COUNT_UPDATED_CHANNEL}`, err);
            return
        }

        console.log(`${count} clients connected to ${CONNECTION_COUNT_UPDATED_CHANNEL} channel`);
    });

    subscriber.subscribe(NEW_MESSAGE_CHANNEL, (err, count) => {
        if(err) {
            console.error(`Error subscribing to ${NEW_MESSAGE_CHANNEL}`, err);
            return
        }
        console.log(`${count} clients subscribed to ${NEW_MESSAGE_CHANNEL} channel`)
    })
    //listen for messages on all channels
    subscriber.on('message', (channel, message) => {
        if(channel === CONNECTION_COUNT_UPDATED_CHANNEL) {

            //send message to all connected clients
            app.io.emit(CONNECTION_COUNT_UPDATED_CHANNEL, {
                count: message
            })
            return;
        }

        if(channel === NEW_MESSAGE_CHANNEL) {

            app.io.emit(NEW_MESSAGE_CHANNEL, {
                message: message,
                id: randomUUID(),
                createdAt: new Date(),
                port: PORT
            })


            return;
        }
    })

    //healtcheck endpoint to check if server is running with different port
    app.get('/healthcheck', ()=> {
        return {
            status: 'ok',
            port: PORT
        }
    })

    return app;
}

//seperate buildServer from main() so we can test it because we dont want to start the server when we run tests

async function main() {
    const app = await buildServer();

    try {
        await app.listen({
            port: PORT,
            host: HOST
        })

        closeWithGrace({delay: 2000}, async({signal, err}) => {
            console.log('shutting down server');
            console.log({err,signal});
            if(connectedClients > 0) {
                console.log(`Removing ${connectedClients} connected clients from count`);

                const currentCount = parseInt((await publisher.get(CONNECTION_COUNT_KEY)) || '0', 10);
                const newCount = currentCount - connectedClients;
                await publisher.set(CONNECTION_COUNT_KEY, String(newCount));
            }
            await app.close();
        })
        console.log(`Server is listening on ${HOST}:${PORT}`)
    }catch(e) {
        console.error(e);
        process.exit(1);
    }
}

main()