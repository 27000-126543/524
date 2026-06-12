import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import http from 'http';
import { wsManager } from './lib/ws';
import { errorHandler, notFoundHandler } from './middleware/error';
import { schedulerService } from './scheduler';
import logger from './lib/logger';

import authRoutes from './routes/auth.routes';
import sampleRoutes from './routes/sample.routes';
import taskRoutes from './routes/task.routes';
import resultRoutes from './routes/result.routes';
import reportRoutes from './routes/report.routes';
import criticalValueRoutes from './routes/criticalValue.routes';
import distributionRoutes from './routes/distribution.routes';
import exportRoutes from './routes/export.routes';
import dailyReportRoutes from './routes/dailyReport.routes';
import workOrderRoutes from './routes/workOrder.routes';

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, _res, next) => {
  logger.info(`${req.method} ${req.path}`);
  next();
});

app.get('/health', (_req, res) => {
  res.json({
    success: true,
    message: '智慧医疗样本检验全流程与报告分发调度系统',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/samples', sampleRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/results', resultRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/critical-values', criticalValueRoutes);
app.use('/api/distribution', distributionRoutes);
app.use('/api/exports', exportRoutes);
app.use('/api/daily-reports', dailyReportRoutes);
app.use('/api/work-orders', workOrderRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

wsManager.init(server);

schedulerService.start();

process.on('SIGTERM', () => {
  logger.info('SIGTERM信号接收，正在关闭服务器...');
  schedulerService.stop();
  server.close(() => {
    logger.info('服务器已关闭');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT信号接收，正在关闭服务器...');
  schedulerService.stop();
  server.close(() => {
    logger.info('服务器已关闭');
    process.exit(0);
  });
});

server.listen(PORT, () => {
  logger.info(`🏥 智慧医疗检验系统API服务已启动`);
  logger.info(`   地址: http://localhost:${PORT}`);
  logger.info(`   环境: ${process.env.NODE_ENV || 'development'}`);
  logger.info(`   API文档: http://localhost:${PORT}/health`);
});

export default app;
