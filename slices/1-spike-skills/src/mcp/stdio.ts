#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './server.js';
import { SkillSdk } from '../sdk/client.js';

const base = process.env.SPIKE_SKILLS_REST_URL;
if (!base) throw new Error('SPIKE_SKILLS_REST_URL is required');
const server = createMcpServer(new SkillSdk(base));
await server.connect(new StdioServerTransport());
