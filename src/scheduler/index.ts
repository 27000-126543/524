import cron from 'node-cron';
import { dailyReportService } from '../services/dailyReport.service';
import { criticalValueService } from '../services/criticalValue.service';
import { reportDistributionService } from '../services/reportDistribution.service';
import { taskAssignmentService } from '../services/taskAssignment.service';
import logger from '../lib/logger';

class SchedulerService {
  private jobs: cron.ScheduledTask[] = [];

  start() {
    this.scheduleDailyReport();
    this.scheduleCriticalEscalation();
    this.scheduleAutoArchive();
    this.scheduleAutoAssignment();

    logger.info('定时任务调度器已启动');
  }

  stop() {
    this.jobs.forEach(job => job.stop());
    this.jobs = [];
    logger.info('定时任务调度器已停止');
  }

  private scheduleDailyReport() {
    const cronExpression = process.env.DAILY_REPORT_CRON || '0 0 0 * * *';
    const job = cron.schedule(cronExpression, async () => {
      try {
        logger.info('开始生成每日运营报表...');
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const result = await dailyReportService.generateDailyReport(yesterday);
        logger.info(`每日运营报表生成完成: ${result.reportDate}`);
      } catch (error) {
        logger.error(`每日运营报表生成失败: ${(error as Error).message}`);
      }
    });

    this.jobs.push(job);
    logger.info(`已注册定时任务: 每日运营报表 (${cronExpression})`);
  }

  private scheduleCriticalEscalation() {
    const job = cron.schedule('*/1 * * * *', async () => {
      try {
        const result = await criticalValueService.checkAndEscalateTimeouts();
        if (result.scanned > 0) {
          logger.info(`危急值超时检查: 扫描${result.scanned}条, 升级${result.escalated}条`);
        }
      } catch (error) {
        logger.error(`危急值超时检查失败: ${(error as Error).message}`);
      }
    });

    this.jobs.push(job);
    logger.info('已注册定时任务: 危急值超时升级检查 (每1分钟)');
  }

  private scheduleAutoArchive() {
    const job = cron.schedule('0 2 0 * * *', async () => {
      try {
        logger.info('开始自动归档已分发报告...');
        const result = await reportDistributionService.autoArchiveDistributedReports();
        logger.info(`自动归档完成: 归档${result.archived}份报告`);
      } catch (error) {
        logger.error(`自动归档失败: ${(error as Error).message}`);
      }
    });

    this.jobs.push(job);
    logger.info('已注册定时任务: 自动归档已分发报告 (每日凌晨2点)');
  }

  private scheduleAutoAssignment() {
    const job = cron.schedule('*/30 * * * * *', async () => {
      try {
        const result = await taskAssignmentService.autoAssignPendingTasks();
        if (result.total > 0) {
          logger.info(`自动任务分配: 共${result.total}个待分配, 成功${result.assigned}个`);
        }
      } catch (error) {
        logger.error(`自动任务分配失败: ${(error as Error).message}`);
      }
    });

    this.jobs.push(job);
    logger.info('已注册定时任务: 自动分配待处理任务 (每30秒)');
  }
}

export const schedulerService = new SchedulerService();
