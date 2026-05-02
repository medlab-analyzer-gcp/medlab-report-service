/**
 * Medical Lab Report Management Service
 *
 * This Cloud Run service handles:
 * - Uploading medical reports to Cloud Storage
 * - Storing metadata in Firestore
 * - Listing user reports
 * - Deleting reports
 * - Generating presigned URLs for file access
 *
 * Factor Compliance:
 * - Factor 3: Configuration via environment variables
 * - Factor 6: Stateless processes
 * - Factor 7: Port binding (self-contained HTTP server)
 * - Factor 9: Disposability (fast startup, graceful shutdown)
 * - Factor 11: Logs to stdout
 */

const express = require("express");
const { Storage } = require("@google-cloud/storage");
const { Firestore } = require("@google-cloud/firestore");
const { PubSub } = require("@google-cloud/pubsub");
const logger = require("./src/utils/logger");

// ==============================================================================
// Configuration (Factor 3: Config in environment)
// ==============================================================================

const PORT = process.env.PORT || 8080;
const PROJECT_ID = process.env.PROJECT_ID;
const BUCKET_NAME = process.env.BUCKET_NAME;
const NODE_ENV = process.env.NODE_ENV || "development";

if (!PROJECT_ID || !BUCKET_NAME) {
  logger.error(
    "Missing required environment variables: PROJECT_ID, BUCKET_NAME",
  );
  process.exit(1);
}

// ==============================================================================
// Initialize GCP Clients
// ==============================================================================

const storage = new Storage({ projectId: PROJECT_ID });
const firestore = new Firestore({ projectId: PROJECT_ID });
const pubsub = new PubSub({ projectId: PROJECT_ID });

const bucket = storage.bucket(BUCKET_NAME);
const reportsCollection = firestore.collection("reports");
const analysisTopic = pubsub.topic("analysis-requests");

// ==============================================================================
// Express Application Setup
// ==============================================================================

const app = express();

// CORS - allow browser requests from any origin
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Middleware
app.use(express.json({ limit: "10mb" }));

// Request logging middleware
app.use((req, res, next) => {
  logger.info("Incoming request", {
    method: req.method,
    path: req.path,
    ip: req.ip,
  });
  next();
});

// ==============================================================================
// Health Check Endpoints (Factor 14: Telemetry)
// ==============================================================================

// Liveness probe
app.get("/health", (req, res) => {
  res.status(200).json({ status: "healthy", service: "report-service" });
});

// Readiness probe
app.get("/ready", async (req, res) => {
  try {
    // Check Firestore connectivity
    await firestore
      .collection("_health")
      .doc("check")
      .set({ timestamp: new Date() });

    // Check Storage connectivity
    await bucket.exists();

    res.status(200).json({
      status: "ready",
      firestore: "connected",
      storage: "connected",
    });
  } catch (error) {
    logger.error("Readiness check failed", { error: error.message });
    res.status(503).json({ status: "not ready", error: error.message });
  }
});

// ==============================================================================
// API Endpoints
// ==============================================================================

/**
 * POST /reports
 * Upload a new medical report
 *
 * Body:
 * {
 *   userId: string,
 *   fileName: string,
 *   fileType: string,
 *   fileContent: string (base64)
 * }
 */
app.post("/reports", async (req, res) => {
  try {
    const { userId, fileName, fileType, fileContent } = req.body;

    // Validation
    if (!userId || !fileName || !fileType || !fileContent) {
      return res.status(400).json({
        error:
          "Missing required fields: userId, fileName, fileType, fileContent",
      });
    }

    // Generate unique file name
    const timestamp = Date.now();
    const uniqueFileName = `${userId}/${timestamp}-${fileName}`;

    // Decode base64 content
    const fileBuffer = Buffer.from(fileContent, "base64");

    // Upload to Cloud Storage
    const file = bucket.file(uniqueFileName);
    await file.save(fileBuffer, {
      contentType: fileType,
      metadata: {
        userId: userId,
        originalName: fileName,
        uploadedAt: new Date().toISOString(),
      },
    });

    logger.info("File uploaded to Cloud Storage", { fileName: uniqueFileName });

    // Create metadata document in Firestore
    const reportData = {
      userId: userId,
      fileName: fileName,
      fileType: fileType,
      storagePath: uniqueFileName,
      fileSize: fileBuffer.length,
      uploadedAt: Firestore.Timestamp.now(),
      createdAt: Firestore.Timestamp.now(),
      status: "uploaded",
    };

    const reportRef = await reportsCollection.add(reportData);

    logger.info("Report metadata saved to Firestore", {
      reportId: reportRef.id,
    });

    res.status(201).json({
      reportId: reportRef.id,
      message: "Report uploaded successfully",
      data: {
        ...reportData,
        reportId: reportRef.id,
        uploadedAt: reportData.uploadedAt.toDate(),
        createdAt: reportData.createdAt.toDate(),
      },
    });
  } catch (error) {
    logger.error("Error uploading report", {
      error: error.message,
      stack: error.stack,
    });
    res
      .status(500)
      .json({ error: "Failed to upload report", details: error.message });
  }
});

/**
 * GET /reports
 * List user's reports
 *
 * Query: ?userId=xxx
 */
app.get("/reports", async (req, res) => {
  try {
    const { userId } = req.query;

    if (!userId) {
      return res
        .status(400)
        .json({ error: "Missing required query parameter: userId" });
    }

    // Query Firestore
    const snapshot = await reportsCollection
      .where("userId", "==", userId)
      .orderBy("createdAt", "desc")
      .get();

    const reports = [];
    snapshot.forEach((doc) => {
      const data = doc.data();
      reports.push({
        reportId: doc.id,
        ...data,
        uploadedAt: data.uploadedAt?.toDate(),
        createdAt: data.createdAt?.toDate(),
      });
    });

    logger.info("Reports retrieved", { userId, count: reports.length });

    res.status(200).json({
      count: reports.length,
      reports: reports,
    });
  } catch (error) {
    logger.error("Error retrieving reports", { error: error.message });
    res
      .status(500)
      .json({ error: "Failed to retrieve reports", details: error.message });
  }
});

/**
 * GET /reports/:id
 * Get a specific report by ID
 */
app.get("/reports/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const doc = await reportsCollection.doc(id).get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Report not found" });
    }

    const data = doc.data();

    res.status(200).json({
      reportId: doc.id,
      ...data,
      uploadedAt: data.uploadedAt?.toDate(),
      createdAt: data.createdAt?.toDate(),
    });
  } catch (error) {
    logger.error("Error retrieving report", {
      error: error.message,
      reportId: req.params.id,
    });
    res
      .status(500)
      .json({ error: "Failed to retrieve report", details: error.message });
  }
});

/**
 * DELETE /reports/:id
 * Delete a report (both file and metadata)
 */
app.delete("/reports/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // Get report metadata
    const doc = await reportsCollection.doc(id).get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Report not found" });
    }

    const data = doc.data();

    // Delete file from Cloud Storage
    const file = bucket.file(data.storagePath);
    await file.delete();

    logger.info("File deleted from Cloud Storage", {
      storagePath: data.storagePath,
    });

    // Delete metadata from Firestore
    await reportsCollection.doc(id).delete();

    logger.info("Report metadata deleted from Firestore", { reportId: id });

    res.status(200).json({
      message: "Report deleted successfully",
      reportId: id,
    });
  } catch (error) {
    logger.error("Error deleting report", {
      error: error.message,
      reportId: req.params.id,
    });
    res
      .status(500)
      .json({ error: "Failed to delete report", details: error.message });
  }
});

/**
 * GET /reports/:id/file-url
 * Generate a presigned URL for file access
 */
app.get("/reports/:id/file-url", async (req, res) => {
  try {
    const { id } = req.params;

    // Get report metadata
    const doc = await reportsCollection.doc(id).get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Report not found" });
    }

    const data = doc.data();

    // Generate signed URL (valid for 1 hour)
    const file = bucket.file(data.storagePath);
    const [url] = await file.getSignedUrl({
      version: "v4",
      action: "read",
      expires: Date.now() + 60 * 60 * 1000, // 1 hour
    });

    logger.info("Presigned URL generated", { reportId: id });

    res.status(200).json({
      reportId: id,
      fileName: data.fileName,
      fileType: data.fileType,
      url: url,
      expiresIn: 3600, // seconds
    });
  } catch (error) {
    logger.error("Error generating presigned URL", {
      error: error.message,
      reportId: req.params.id,
    });
    res
      .status(500)
      .json({ error: "Failed to generate file URL", details: error.message });
  }
});

// ==============================================================================
// POST /analyze-request
// Publishes analysis request to Pub/Sub (event-driven flow)
// ==============================================================================

app.post("/analyze-request", async (req, res) => {
  try {
    const { reportId, userId, testResults, patientInfo } = req.body;

    if (!reportId || !userId || !testResults || !patientInfo) {
      return res.status(400).json({
        error: "Missing required fields: reportId, userId, testResults, patientInfo",
      });
    }

    if (!patientInfo.age || !patientInfo.gender) {
      return res.status(400).json({
        error: "patientInfo must include age and gender",
      });
    }

    // Publish message to Pub/Sub
    const message = Buffer.from(JSON.stringify({
      reportId,
      userId,
      testResults,
      patientInfo,
    }));

    await analysisTopic.publishMessage({ data: message });

    logger.info("Analysis request published to Pub/Sub", { reportId, userId });

    // Return immediately — analysis happens asynchronously
    res.status(202).json({
      message: "Analysis request queued",
      reportId,
    });
  } catch (error) {
    logger.error("Error publishing analysis request", { error: error.message });
    res.status(500).json({ error: "Failed to queue analysis request" });
  }
});

// ==============================================================================
// Error Handling
// ==============================================================================

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Endpoint not found" });
});

// Global error handler
app.use((err, req, res, next) => {
  logger.error("Unhandled error", { error: err.message, stack: err.stack });
  res.status(500).json({ error: "Internal server error" });
});

// ==============================================================================
// Server Lifecycle (Factor 9: Disposability)
// ==============================================================================

let server;

function startServer() {
  server = app.listen(PORT, () => {
    logger.info(`Report Service started`, {
      port: PORT,
      environment: NODE_ENV,
      projectId: PROJECT_ID,
      bucket: BUCKET_NAME,
    });
  });
}

// Graceful shutdown handler
async function gracefulShutdown(signal) {
  logger.info(`${signal} received, starting graceful shutdown`);

  if (server) {
    server.close(() => {
      logger.info("HTTP server closed");

      // Close Firestore connection
      firestore.terminate().then(() => {
        logger.info("Firestore connection closed");
        process.exit(0);
      });
    });

    // Force shutdown after 10 seconds
    setTimeout(() => {
      logger.warn("Forcing shutdown after timeout");
      process.exit(1);
    }, 10000);
  }
}

// Handle termination signals
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Start the server
startServer();
