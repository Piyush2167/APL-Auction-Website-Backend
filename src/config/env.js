require('dotenv').config({ quiet: true });
const { z } = require('zod');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  MONGODB_URI: z.string().min(1).optional(),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 chars'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 chars'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_DAYS: z.coerce.number().default(7),
  TEMP_PASSWORD_HOURS: z.coerce.number().default(48),
  FRONTEND_URL: z.string().default('http://localhost:3000'),
  CORS_ORIGINS: z.string().optional(), // comma separated; defaults to FRONTEND_URL
  EMAIL_HOST: z.string().optional(),
  EMAIL_PORT: z.coerce.number().optional(),
  EMAIL_USER: z.string().optional(),
  EMAIL_PASSWORD: z.string().optional(),
  EMAIL_FROM: z.string().default('APL Auction <no-reply@apl-auction.local>'),
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
  LOG_LEVEL: z.string().default('info'),
  // Secret for the /super?key=... mystery board link. Unset = the link is disabled.
  SUPER_VIEW_KEY: z.string().min(16, 'SUPER_VIEW_KEY must be at least 16 chars').optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment:', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  process.exit(1);
}
const env = parsed.data;
env.corsOrigins = (env.CORS_ORIGINS || env.FRONTEND_URL).split(',').map((s) => s.trim()).filter(Boolean);
env.isProd = env.NODE_ENV === 'production';
env.isTest = env.NODE_ENV === 'test';
module.exports = env;
