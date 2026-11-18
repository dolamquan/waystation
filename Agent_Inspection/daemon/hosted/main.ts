import { createHostedGateway, loadHostedOptions } from './gateway.ts';
const file = process.env.WAYSTATION_HOSTED_CONFIG;
if (!file) throw new Error('Set WAYSTATION_HOSTED_CONFIG to the organization configuration file.');
const server = createHostedGateway(loadHostedOptions(file));
server.listen(Number(process.env.PORT ?? 8080), '0.0.0.0', () => console.log('Hosted gateway is ready.'));
const shutdown = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 10000).unref(); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
