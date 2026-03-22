const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();

// ====================== 安全配置：从环境变量读取 ======================
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_PWD = process.env.ADMIN_PWD;
const SERVER_DOMAIN = process.env.SERVER_DOMAIN;

const FIXED_CAR_ORDER = [
    '4月11日早送','4月11日晚接','4月12日早送','4月12日晚接',
    '4月11日中午考点更换','4月12日中午考点更换'
];
const CAR_PRICE_MAP = {
    '4月11日早送':20,'4月11日晚接':20,'4月12日早送':20,'4月12日晚接':20,
    '4月11日中午考点更换':3,'4月12日中午考点更换':3
};
// ====================================================================

// 安全跨域
app.use(cors({
  origin: true,
  methods: ['GET','POST','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ====================== 本地文件存储（唯一存储逻辑，无重复） ======================
const uploadDir = path.join(__dirname, 'uploads');
// 确保uploads文件夹存在
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true }); // 加recursive兼容多级目录
}
// 暴露uploads文件夹，让前端能访问图片
app.use('/uploads', express.static(uploadDir));

// 只声明一次storage（解决重复声明错误）
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    // 生成唯一文件名，避免重复
    const filename = `screenshot_${Date.now()}_${Math.random().toString(36).substr(2,8)}${ext}`;
    cb(null, filename);
  }
});

const upload = multer({ 
  storage, 
  limits: { fileSize: 10 * 1024 * 1024 }, // 限制10MB
  fileFilter: (req, file, cb) => {
    const types = ['image/jpeg','image/png','image/jpg','image/webp'];
    if(types.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('仅支持 JPG / PNG / WebP 图片'), false);
    }
  }
});

// ====================== MongoDB 连接（加错误捕获，避免进程退出） ======================
mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ MongoDB连接成功'))
  .catch(err => {
    console.error('❌ MongoDB连接失败', err);
    // 连接失败延迟退出，方便看日志
    setTimeout(() => process.exit(1), 3000);
  });

// ====================== 订单模型（修复重复字段） ======================
const OrderSchema = new mongoose.Schema({
  userName: String,
  userPhone: String,
  total: Number,
  carList: Array,
  orderId: { type: String, unique: true },
  payType: String,
  createTime: String,
  paymentRecords: Array,
  orderModified: Boolean,
  lastOperationType: String,
  submittedCarList: Array,
  payScreenshots: { type: Array, default: [] }, // 只声明一次！
  submitCount: { type: Number, default: 1 }
}, { suppressReservedKeysWarning: true });

const Order = mongoose.model('Order', OrderSchema);

// ====================== 工具函数 ======================
function get24HourTime() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,0)}-${String(d.getDate()).padStart(2,0)} ${String(d.getHours()).padStart(2,0)}:${String(d.getMinutes()).padStart(2,0)}:${String(d.getSeconds()).padStart(2,0)}`;
}

function sortCarList(carList) {
  return FIXED_CAR_ORDER.map(name => carList.find(i => i.name === name)).filter(Boolean);
}

function calculateTotalAmount(carList) {
  return carList.reduce((sum, i) => sum + (CAR_PRICE_MAP[i.name] || 0), 0);
}

function isCarListModified(a, b) {
  const na = (a||[]).map(i=>i.name).sort();
  const nb = (b||[]).map(i=>i.name).sort();
  return na.length !== nb.length || !na.every((v,i) => v === nb[i]);
}

// ====================== 管理员权限校验 ======================
function adminAuth(req, res, next) {
  const pwd = req.body.pwd || req.query.pwd;
  if (!pwd || pwd !== ADMIN_PWD) {
    return res.json({ code: -2, msg: "无权限" });
  }
  next();
}

// ====================== 上传截图（修复重复逻辑，只保留本地存储） ======================
app.post('/api/uploadScreenshot', upload.array('screenshots', 5), async (req, res) => {
  try {
    const { orderId } = req.body;
    // 校验参数
    if (!orderId || !req.files || req.files.length === 0) {
      return res.json({ code:-1, msg:'请选择图片并传入正确的订单号' });
    }

    // 生成可访问的图片URL
    const urls = req.files.map(file => {
      return `${SERVER_DOMAIN}/uploads/${file.filename}`;
    });

    // 更新订单的截图列表
    await Order.findOneAndUpdate(
      { orderId },
      { $push: { payScreenshots: { $each: urls } } },
      { new: true } // 返回更新后的文档
    );

    res.json({ code:0, msg:'上传成功', screenshotUrls: urls });
  } catch (e) {
    console.error("上传截图失败：", e);
    res.json({ code:-1, msg:'上传失败，请重试' });
  }
});

// ====================== 提交订单 ======================
app.post('/api/submitOrder', async (req, res) => {
  try {
    const { userName, userPhone, payType, carList, createTime } = req.body;
    const submitTime = createTime || get24HourTime();

    // 查找是否已有该用户的订单
    const exist = await Order.findOne({ 
      userName: userName?.trim(), 
      userPhone: userPhone?.trim() 
    });

    if (exist) {
      // 追加订单逻辑
      const oldNames = exist.carList.map(i => i.name);
      const newCars = carList.filter(i => !oldNames.includes(i.name));
      const merged = sortCarList([...exist.carList, ...newCars]);
      const newTotal = calculateTotalAmount(merged);

      // 追加支付记录
      exist.paymentRecords.push({
        payType: payType || '-',
        amount: calculateTotalAmount(newCars),
        time: submitTime
      });

      await Order.findByIdAndUpdate(exist._id, {
        total: newTotal,
        carList: merged,
        payType: payType || exist.payType,
        createTime: submitTime,
        paymentRecords: exist.paymentRecords,
        lastOperationType: 'submit',
        submittedCarList: merged,
        submitCount: exist.submitCount + 1
      });

      return res.json({ code:0, msg:'追加成功', orderId: exist.orderId });
    }

    // 新建订单逻辑
    const sorted = sortCarList(carList || []);
    const calcTotal = calculateTotalAmount(sorted);
    const orderId = 'ORD' + Date.now();
    const order = new Order({
      userName, 
      userPhone,
      payType: payType || '-',
      total: calcTotal,
      carList: sorted,
      orderId,
      createTime: submitTime,
      paymentRecords: [{ 
        payType: payType || '-', 
        amount: calcTotal, 
        time: submitTime 
      }],
      lastOperationType: 'submit',
      submittedCarList: sorted,
      payScreenshots: [],
      submitCount: 1
    });
    await order.save();
    res.json({ code:0, msg:'提交成功', orderId });
  } catch (e) {
    console.error("提交订单失败：", e);
    res.json({ code:-1, msg:'提交失败，请重试' });
  }
});

// ====================== 查询订单 ======================
app.get('/api/queryOrder', async (req, res) => {
  try {
    const { userName } = req.query;
    if (!userName) {
      return res.json({ code:-1, msg:'请传入用户名' });
    }
    const list = await Order.find({ userName });
    const result = list.map(o => {
      const cars = sortCarList(o.carList||[]);
      const realTotal = calculateTotalAmount(cars);
      const modified = isCarListModified(o.submittedCarList, cars);
      return {
        ...o.toObject(),
        carList: cars,
        total: realTotal,
        isManuallyModified: modified,
        isMultiSubmit: o.submitCount > 1
      };
    });
    res.json({ code:0, data: result });
  } catch (e) {
    console.error("查询订单失败：", e);
    res.json({ code:-1, msg:'查询失败，请重试' });
  }
});

// ====================== 管理员接口 ======================
app.get('/api/getAllOrders', adminAuth, async (req, res) => {
  try {
    const orders = await Order.find().sort({ _id:-1 });
    const data = orders.map(o => {
      const cars = sortCarList(o.carList||[]);
      const realTotal = calculateTotalAmount(cars);
      const modified = isCarListModified(o.submittedCarList, cars);
      return {
        ...o.toObject(),
        id: o._id.toString(),
        carList: cars,
        total: realTotal,
        isManuallyModified: modified,
        isMultiSubmit: o.submitCount > 1
      };
    });
    res.json({ code:0, data });
  } catch (e) {
    console.error("获取所有订单失败：", e);
    res.json({ code:-1, msg:'加载失败，请重试' });
  }
});

app.post('/api/deleteOrder', adminAuth, async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) {
      return res.json({ code:-1, msg:'请传入订单ID' });
    }
    await Order.findByIdAndDelete(id);
    res.json({ code:0, msg:'删除成功' });
  } catch (e) {
    console.error("删除订单失败：", e);
    res.json({ code:-1, msg:'删除失败，请重试' });
  }
});

app.post('/api/recalculateAmount', adminAuth, async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) {
      return res.json({ code:-1, msg:'请传入订单号' });
    }
    const o = await Order.findOne({ orderId });
    if (!o) {
      return res.json({ code:-1, msg:'订单不存在' });
    }
    const newTotal = calculateTotalAmount(o.carList);
    await Order.findByIdAndUpdate(o._id, { 
      total: newTotal, 
      lastOperationType:'modify' 
    });
    res.json({ code:0, msg:'刷新成功' });
  } catch (e) {
    console.error("刷新金额失败：", e);
    res.json({ code:-1, msg:'刷新失败，请重试' });
  }
});

// 冗余删除接口（保留即可，不影响主逻辑）
app.delete('/api/deleteOrder', async (req, res) => {
  try {
    const { orderId } = req.query;
    if (!orderId) return res.json({ code:-1, msg:'缺少订单号' });
    await Order.findOneAndDelete({ orderId });
    res.json({ code:0, msg:'订单删除成功' });
  } catch (e) {
    console.error("删除订单（GET）失败：", e);
    res.json({ code:-1, msg:'删除失败' });
  }
});

// ====================== 启动服务 ======================
const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`✅ 服务启动成功：端口 ${port}`);
  console.log(`✅ 图片访问地址：${SERVER_DOMAIN}/uploads/文件名`);
});

// 捕获未处理的异常，避免进程直接退出
process.on('uncaughtException', (err) => {
  console.error('❌ 未捕获的异常：', err);
  setTimeout(() => process.exit(1), 3000);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ 未处理的Promise拒绝：', reason, promise);
  setTimeout(() => process.exit(1), 3000);
});
