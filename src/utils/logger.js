/**
 * Logger Utility (Factor 11: Logs as Event Streams)
 *
 * Logs to stdout in JSON format for Cloud Logging ingestion
 */

const winston = require("winston");

const LOG_LEVEL = process.env.LOG_LEVEL || "info";

const logger = winston.createLogger({
  level: LOG_LEVEL,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json(),
  ),
  defaultMeta: {
    service: "report-service",
    version: "1.0.0",
  },
  transports: [
    // Factor 11: Only log to stdout, let Cloud Logging handle persistence
    new winston.transports.Console(),
  ],
});

module.exports = logger;
