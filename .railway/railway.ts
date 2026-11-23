import { defineRailway, postgres, project, service } from 'railway/iac';

export default defineRailway(ctx => {
  if (!ctx.isEnvironment('staging')) throw new Error('Use the staging environment');

  return project(ctx.projectName, {
    resources: [
      service('web', {
        build: 'node scripts/next.mjs build --webpack',
        start: 'node scripts/next.mjs start --hostname :: --port "$PORT"',
        healthcheck: '/health/ready'
      }),
      service('api', {
        build: 'npm run db:generate && npm run build --workspace=@founders-lens/api',
        start: 'node apps/api/dist/main.js',
        healthcheck: '/health/ready',
        env: { NODE_ENV: 'production', FL_DEPLOYMENT: 'staging' }
      }),
      postgres('primary-postgres'),
      postgres('privacy-postgres')
    ]
  });
});
