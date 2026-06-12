import { PrismaClient, UserRole, SampleType, DeviceStatus } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 开始种子数据...');

  const hashedPassword = await bcrypt.hash('123456', 10);

  const deptLab = await prisma.department.upsert({
    where: { code: 'LAB' },
    update: {},
    create: {
      name: '检验科',
      code: 'LAB',
      type: 'LAB',
      isLab: true,
      description: '临床检验科',
    },
  });

  const deptLabMicro = await prisma.department.upsert({
    where: { code: 'LAB_MICRO' },
    update: {},
    create: {
      name: '微生物室',
      code: 'LAB_MICRO',
      type: 'LAB',
      isLab: true,
      description: '微生物检验室',
    },
  });

  const deptClinical = await prisma.department.upsert({
    where: { code: 'INTERNAL' },
    update: {},
    create: {
      name: '内科',
      code: 'INTERNAL',
      type: 'CLINICAL',
      isLab: false,
      description: '内科门诊',
    },
  });

  const deptSurgery = await prisma.department.upsert({
    where: { code: 'SURGERY' },
    update: {},
    create: {
      name: '外科',
      code: 'SURGERY',
      type: 'CLINICAL',
      isLab: false,
      description: '外科门诊',
    },
  });

  const admin = await prisma.user.upsert({
    where: { username: 'admin' },
    update: {},
    create: {
      username: 'admin',
      password: hashedPassword,
      name: '系统管理员',
      role: UserRole.ADMIN,
      email: 'admin@hospital.com',
      phone: '13800000001',
    },
  });

  const labTech = await prisma.user.upsert({
    where: { username: 'labtech1' },
    update: {},
    create: {
      username: 'labtech1',
      password: hashedPassword,
      name: '张检验',
      role: UserRole.LAB_TECHNICIAN,
      departmentId: deptLab.id,
      email: 'labtech1@hospital.com',
      phone: '13800000002',
    },
  });

  const labDirector = await prisma.user.upsert({
    where: { username: 'labdirector' },
    update: {},
    create: {
      username: 'labdirector',
      password: hashedPassword,
      name: '李主任',
      role: UserRole.LAB_DIRECTOR,
      departmentId: deptLab.id,
      email: 'labdirector@hospital.com',
      phone: '13800000003',
    },
  });

  const clinician = await prisma.user.upsert({
    where: { username: 'clinician1' },
    update: {},
    create: {
      username: 'clinician1',
      password: hashedPassword,
      name: '王医生',
      role: UserRole.CLINICIAN,
      departmentId: deptClinical.id,
      email: 'clinician1@hospital.com',
      phone: '13800000004',
    },
  });

  const deptHead = await prisma.user.upsert({
    where: { username: 'depthead1' },
    update: {},
    create: {
      username: 'depthead1',
      password: hashedPassword,
      name: '赵科主任',
      role: UserRole.DEPARTMENT_HEAD,
      departmentId: deptLab.id,
      email: 'depthead1@hospital.com',
      phone: '13800000005',
    },
  });

  const medAffairs = await prisma.user.upsert({
    where: { username: 'medaffairs' },
    update: {},
    create: {
      username: 'medaffairs',
      password: hashedPassword,
      name: '医务科陈科长',
      role: UserRole.MEDICAL_AFFAIRS,
      email: 'medaffairs@hospital.com',
      phone: '13800000006',
    },
  });

  const cbc = await prisma.labTest.upsert({
    where: { code: 'CBC' },
    update: {},
    create: {
      code: 'CBC',
      name: '血常规',
      departmentId: deptLab.id,
      sampleType: SampleType.BLOOD,
      turnaroundTime: 30,
      price: 25.00,
      unit: '',
      referenceRange: 'WBC:4-10;RBC:3.5-5.5;HGB:120-160;PLT:100-300',
    },
  });

  const liverFunc = await prisma.labTest.upsert({
    where: { code: 'LFT' },
    update: {},
    create: {
      code: 'LFT',
      name: '肝功能',
      departmentId: deptLab.id,
      sampleType: SampleType.BLOOD,
      turnaroundTime: 60,
      price: 80.00,
      unit: 'U/L',
      referenceRange: 'ALT:0-40;AST:0-40;TBIL:3.4-17.1',
      criticalLow: 'ALT:0;AST:0',
      criticalHigh: 'ALT:500;AST:500;TBIL:342',
    },
  });

  const kidneyFunc = await prisma.labTest.upsert({
    where: { code: 'KFT' },
    update: {},
    create: {
      code: 'KFT',
      name: '肾功能',
      departmentId: deptLab.id,
      sampleType: SampleType.BLOOD,
      turnaroundTime: 60,
      price: 60.00,
      unit: 'μmol/L',
      referenceRange: 'BUN:2.6-7.5;CREA:44-133;UA:150-416',
      criticalHigh: 'CREA:707;BUN:35.7',
    },
  });

  const bloodSugar = await prisma.labTest.upsert({
    where: { code: 'GLU' },
    update: {},
    create: {
      code: 'GLU',
      name: '血糖',
      departmentId: deptLab.id,
      sampleType: SampleType.BLOOD,
      turnaroundTime: 30,
      price: 10.00,
      unit: 'mmol/L',
      referenceRange: '3.9-6.1',
      criticalLow: '2.2',
      criticalHigh: '22.2',
    },
  });

  const urineTest = await prisma.labTest.upsert({
    where: { code: 'URINALYSIS' },
    update: {},
    create: {
      code: 'URINALYSIS',
      name: '尿常规',
      departmentId: deptLab.id,
      sampleType: SampleType.URINE,
      turnaroundTime: 30,
      price: 20.00,
      unit: '',
      referenceRange: 'PRO:阴性;GLU:阴性;WBC:阴性;RBC:阴性',
    },
  });

  const hbsag = await prisma.labTest.upsert({
    where: { code: 'HBsAg' },
    update: {},
    create: {
      code: 'HBsAg',
      name: '乙肝表面抗原',
      departmentId: deptLabMicro.id,
      sampleType: SampleType.BLOOD,
      turnaroundTime: 120,
      price: 50.00,
      unit: '',
      referenceRange: '阴性',
    },
  });

  const wbc = await prisma.labTest.upsert({
    where: { code: 'WBC' },
    update: {},
    create: {
      code: 'WBC',
      name: '白细胞计数',
      departmentId: deptLab.id,
      sampleType: SampleType.BLOOD,
      turnaroundTime: 15,
      price: 8.00,
      unit: '×10⁹/L',
      referenceRange: '4-10',
      criticalLow: '1',
      criticalHigh: '30',
    },
  });

  const hgb = await prisma.labTest.upsert({
    where: { code: 'HGB' },
    update: {},
    create: {
      code: 'HGB',
      name: '血红蛋白',
      departmentId: deptLab.id,
      sampleType: SampleType.BLOOD,
      turnaroundTime: 15,
      price: 8.00,
      unit: 'g/L',
      referenceRange: '120-160',
      criticalLow: '50',
      criticalHigh: '200',
    },
  });

  const neutPct = await prisma.labTest.upsert({
    where: { code: 'NEUT_PCT' },
    update: {},
    create: {
      code: 'NEUT_PCT',
      name: '中性粒细胞百分比',
      departmentId: deptLab.id,
      sampleType: SampleType.BLOOD,
      turnaroundTime: 15,
      price: 8.00,
      unit: '%',
      referenceRange: '40-75',
    },
  });

  const mcv = await prisma.labTest.upsert({
    where: { code: 'MCV' },
    update: {},
    create: {
      code: 'MCV',
      name: '平均红细胞体积',
      departmentId: deptLab.id,
      sampleType: SampleType.BLOOD,
      turnaroundTime: 15,
      price: 8.00,
      unit: 'fL',
      referenceRange: '80-100',
    },
  });

  const device1 = await prisma.device.upsert({
    where: { code: 'HEM-ANALYZER-01' },
    update: {},
    create: {
      code: 'HEM-ANALYZER-01',
      name: '血液分析仪A',
      model: 'XS-800i',
      departmentId: deptLab.id,
      status: DeviceStatus.ONLINE,
      maxLoad: 200,
      currentLoad: 0,
    },
  });

  const device2 = await prisma.device.upsert({
    where: { code: 'CHEM-ANALYZER-01' },
    update: {},
    create: {
      code: 'CHEM-ANALYZER-01',
      name: '生化分析仪A',
      model: 'Cobas 8000',
      departmentId: deptLab.id,
      status: DeviceStatus.ONLINE,
      maxLoad: 300,
      currentLoad: 0,
    },
  });

  const device3 = await prisma.device.upsert({
    where: { code: 'URINE-ANALYZER-01' },
    update: {},
    create: {
      code: 'URINE-ANALYZER-01',
      name: '尿液分析仪A',
      model: 'UX-2000',
      departmentId: deptLab.id,
      status: DeviceStatus.ONLINE,
      maxLoad: 150,
      currentLoad: 0,
    },
  });

  await prisma.deviceTest.createMany({
    data: [
      { deviceId: device1.id, testId: cbc.id },
      { deviceId: device1.id, testId: wbc.id },
      { deviceId: device1.id, testId: hgb.id },
      { deviceId: device1.id, testId: neutPct.id },
      { deviceId: device1.id, testId: mcv.id },
      { deviceId: device2.id, testId: liverFunc.id },
      { deviceId: device2.id, testId: kidneyFunc.id },
      { deviceId: device2.id, testId: bloodSugar.id },
      { deviceId: device3.id, testId: urineTest.id },
    ],
    skipDuplicates: true,
  });

  const patient1 = await prisma.patient.upsert({
    where: { mrn: 'P20240001' },
    update: {},
    create: {
      mrn: 'P20240001',
      name: '刘患者',
      gender: '男',
      birthDate: new Date('1985-06-15'),
      phone: '13900000001',
      bloodType: 'A',
    },
  });

  const patient2 = await prisma.patient.upsert({
    where: { mrn: 'P20240002' },
    update: {},
    create: {
      mrn: 'P20240002',
      name: '陈患者',
      gender: '女',
      birthDate: new Date('1990-03-22'),
      phone: '13900000002',
      bloodType: 'O',
    },
  });

  console.log('✅ 种子数据完成!');
  console.log(`   用户: admin/labtech1/labdirector/clinician1/depthead1/medaffairs (密码: 123456)`);
  console.log(`   科室: 检验科、微生物室、内科、外科`);
  console.log(`   检测项目: 血常规、肝功能、肾功能、血糖、尿常规、乙肝表面抗原等`);
  console.log(`   设备: 血液分析仪、生化分析仪、尿液分析仪`);
  console.log(`   患者: 刘患者、陈患者`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
