export const version = 31;
export const description = 'Add indexes for analytics rollup queries (#559)';

export function up(db) {
  db.exec(`
    -- Ensure created_at is indexed for time-range rollup queries
    CREATE INDEX IF NOT EXISTS idx_analytics_events_created_at
      ON analytics_events(created_at);

    -- Compound index for rollup aggregations
    CREATE INDEX IF NOT EXISTS idx_analytics_events_rollup
      ON analytics_events(event_name, campaign_id, created_at);
  `);
}
