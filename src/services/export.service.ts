import * as XLSX from 'xlsx';
import prisma from '../lib/prisma';
import { ReportStatus } from '@prisma/client';
import { NotFoundError } from '../middleware/error';

class ExportService {
  async exportTestList(params: {
    patientId?: string;
    startDate?: Date;
    endDate?: Date;
    departmentId?: string;
    format: 'xlsx' | 'csv' | 'json';
  }) {
    const { patientId, startDate, endDate, departmentId } = params;

    const where: any = {
      status: { in: [ReportStatus.DISTRIBUTED, ReportStatus.ARCHIVED] },
    };
    if (patientId) where.patientId = patientId;
    if (departmentId) where.departmentId = departmentId;
    if (startDate || endDate) {
      where.approvedAt = {};
      if (startDate) where.approvedAt.gte = startDate;
      if (endDate) where.approvedAt.lte = endDate;
    }

    const reports = await prisma.report.findMany({
      where,
      include: {
        patient: { select: { mrn: true, name: true, gender: true, birthDate: true } },
        department: { select: { name: true } },
        sample: {
          include: {
            testResults: {
              include: { labTest: true },
              orderBy: { createdAt: 'asc' },
            },
          },
        },
        reviewedBy: { select: { name: true } },
      },
      orderBy: { approvedAt: 'desc' },
    });

    if (reports.length === 0) {
      throw new NotFoundError('没有符合条件的检验记录');
    }

    const rows: any[] = [];
    for (const report of reports) {
      for (const result of report.sample.testResults) {
        rows.push({
          报告编号: report.reportNo,
          样本编号: report.sample.sampleNo,
          就诊号: report.patient.mrn,
          患者姓名: report.patient.name,
          性别: report.patient.gender,
          年龄: this.calculateAge(report.patient.birthDate),
          科室: report.department.name,
          检验项目: result.labTest.name,
          项目编码: result.labTest.code,
          结果值: result.resultValue,
          数值: result.numericValue ? result.numericValue.toNumber() : '',
          单位: result.unit || '',
          参考范围: result.referenceRange || '',
          结果标记: this.translateFlag(result.flag),
          是否异常: result.isAbnormal ? '是' : '否',
          是否危急: result.isCritical ? '是' : '否',
          历史比对备注: result.historicalDiff || '',
          检验人员: result.testedBy || '',
          检验时间: result.testedAt?.toISOString() || '',
          审核医生: report.reviewedBy?.name || '',
          审核时间: report.approvedAt?.toISOString() || '',
          报告状态: this.translateReportStatus(report.status),
        });
      }
    }

    return this.formatExport(rows, params.format, `检验清单_${this.formatDate(new Date())}`);
  }

  async exportFeeDetails(params: {
    patientId?: string;
    startDate?: Date;
    endDate?: Date;
    departmentId?: string;
    format: 'xlsx' | 'csv' | 'json';
  }) {
    const { patientId, startDate, endDate, departmentId } = params;

    const where: any = {};
    if (patientId) where.patientId = patientId;
    if (startDate || endDate) {
      where.orderTime = {};
      if (startDate) where.orderTime.gte = startDate;
      if (endDate) where.orderTime.lte = endDate;
    }

    const requisitions = await prisma.requisitionOrder.findMany({
      where,
      include: {
        patient: { select: { mrn: true, name: true } },
        orderedBy: { select: { name: true } },
        items: {
          include: {
            labTest: {
              include: {
                department: { select: { id: true, name: true } },
              },
            },
          },
        },
      },
      orderBy: { orderTime: 'desc' },
    });

    const filteredReqs = requisitions.map(req => ({
      ...req,
      items: req.items.filter(item => !departmentId || item.labTest?.departmentId === departmentId),
    })).filter(req => req.items.length > 0);

    if (filteredReqs.length === 0) {
      throw new NotFoundError('没有符合条件的费用记录');
    }

    const rows: any[] = [];
    let total = 0;
    for (const req of filteredReqs) {
      let reqTotal = 0;
      for (const item of req.items) {
        const price = item.labTest?.price?.toNumber() || 0;
        const itemTotal = price * item.quantity;
        reqTotal += itemTotal;
        rows.push({
          申请单号: req.orderNo,
          就诊号: req.patient.mrn,
          患者姓名: req.patient.name,
          开单医生: req.orderedBy?.name || '',
          开单时间: req.orderTime.toISOString(),
          紧急程度: this.translateUrgency(req.urgency),
          临床诊断: req.clinicalDiagnosis || '',
          项目编码: item.labTest?.code || '',
          检验项目: item.labTest?.name || '',
          执行科室: item.labTest?.department?.name || '',
          单价: price.toFixed(2),
          数量: item.quantity,
          小计: itemTotal.toFixed(2),
        });
      }
      total += reqTotal;
    }

    rows.push({
      申请单号: '',
      就诊号: '',
      患者姓名: '',
      开单医生: '',
      开单时间: '',
      紧急程度: '',
      临床诊断: '合计',
      项目编码: '',
      检验项目: '',
      执行科室: '',
      单价: '',
      数量: '',
      小计: total.toFixed(2),
    });

    return this.formatExport(rows, params.format, `费用明细_${this.formatDate(new Date())}`);
  }

  private formatExport(rows: any[], format: 'xlsx' | 'csv' | 'json', filename: string) {
    if (format === 'json') {
      return {
        format,
        filename: `${filename}.json`,
        contentType: 'application/json',
        data: JSON.stringify(rows, null, 2),
      };
    }

    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');

    if (format === 'csv') {
      return {
        format,
        filename: `${filename}.csv`,
        contentType: 'text/csv; charset=utf-8',
        data: XLSX.write(wb, { type: 'buffer', bookType: 'csv' }),
      };
    }

    return {
      format,
      filename: `${filename}.xlsx`,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      data: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }),
    };
  }

  private calculateAge(birthDate: Date): string {
    const now = new Date();
    let age = now.getFullYear() - birthDate.getFullYear();
    const m = now.getMonth() - birthDate.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < birthDate.getDate())) {
      age--;
    }
    return `${age}岁`;
  }

  private formatDate(date: Date): string {
    return date.toISOString().slice(0, 10);
  }

  private translateFlag(flag: string): string {
    const map: Record<string, string> = {
      NORMAL: '正常',
      ABNORMAL_LOW: '偏低',
      ABNORMAL_HIGH: '偏高',
      CRITICAL_LOW: '危急低',
      CRITICAL_HIGH: '危急高',
      INCONCLUSIVE: '未定',
    };
    return map[flag] || flag;
  }

  private translateReportStatus(status: string): string {
    const map: Record<string, string> = {
      DRAFT: '草稿',
      PENDING_REVIEW: '待审核',
      LOCKED: '已锁定',
      APPROVED: '已审核',
      DISTRIBUTED: '已分发',
      ARCHIVED: '已归档',
    };
    return map[status] || status;
  }

  private translateUrgency(urgency: string): string {
    const map: Record<string, string> = {
      ROUTINE: '常规',
      URGENT: '紧急',
      EMERGENCY: '急诊',
      CRITICAL: '危重',
    };
    return map[urgency] || urgency;
  }
}

export const exportService = new ExportService();
