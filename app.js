const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const multer = require('multer');
require('dotenv').config();

const app = express();

// ====================== 环境变量配置 ======================
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_PWD = process.env.ADMIN_PWD;

// 订单类型配置
const FIXED_CAR_ORDER = [
    '4月11日早送','4月11日晚接','4月12日早送','4月12日晚接',
    '4月11日中午考点更换','4月12日中午考点更换'
];
const CAR_PRICE_MAP = {
    '4月11日早送':20,'4月11日晚接':20,'4月12日早送':20,'4月12日晚接':20,
    '4月11日中午考点更换':3,'4月12日中午考点更换':3
};

// ====================== 基础配置 ======================
// 跨域配置
app.use(cors({
  origin: true,
  methods: ['GET','POST','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: true
}));

// 解析请求体
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ====================== Multer 配置（内存存储，转Base64） ======================
// 仅在内存中存储文件，用于转Base64（不写本地文件）
const storage = multer.memoryStorage();
const upload = multer({ 
  storage, 
  limits: { fileSize: 10 * 1024 * 1024 }, // 限制单文件10MB
  fileFilter: (req, file, cb) => {
    // 仅允许图片格式
    const allowedTypes = ['image/jpeg', 'image/png', 'image/jpg', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('仅支持上传 JPG/PNG/WebP 格式的图片'), false);
    }
  }
});

// ====================== MongoDB 连接 ======================
mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ MongoDB 连接成功'))
  .catch(err => {
    console.error('❌ MongoDB 连接失败：', err);
    setTimeout(() => process.exit(1), 3000); // 延迟退出，便于查看日志
  });

// ====================== 数据模型 ======================
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
  payScreenshots: { type: Array, default: [] }, // 存储Base64格式的图片字符串
  submitCount: { type: Number, default: 1 }
}, { suppressReservedKeysWarning: true });

const Order = mongoose.model('Order', OrderSchema);

// ====================== 工具函数 ======================
// 获取格式化时间
function get24HourTime() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

// 排序车辆列表
function sortCarList(carList) {
  return FIXED_CAR_ORDER.map(name => carList.find(i => i.name === name)).filter(Boolean);
}

// 计算总金额
function calculateTotalAmount(carList) {
  return carList.reduce((sum, item) => sum + (CAR_PRICE_MAP[item.name] || 0), 0);
}

// 判断订单是否修改
function isCarListModified(a, b) {
  const namesA = (a || []).map(i => i.name).sort();
  const namesB = (b || []).map(i => i.name).sort();
  return namesA.length !== namesB.length || !namesA.every((name, idx) => name === namesB[idx]);
}

// ====================== 权限中间件 ======================
function adminAuth(req, res, next) {
  const pwd = req.body.pwd || req.query.pwd;
  if (!pwd || pwd !== ADMIN_PWD) {
    return res.json({ code: -2, msg: "无管理员权限" });
  }
  next();
}

// ====================== 核心接口 ======================
/**
 * 上传截图接口（转Base64存入MongoDB）
 */
app.post('/api/uploadScreenshot', upload.array('screenshots', 5), async (req, res) => {
  try {
    const { orderId } = req.body;
    
    // 参数校验
    if (!orderId) {
      return res.json({ code: -1, msg: '请传入订单号' });
    }
    if (!req.files || req.files.length === 0) {
      return res.json({ code: -1, msg: '请选择要上传的图片' });
    }

    // 将图片转为Base64格式（前端可直接用此字符串显示图片）
    const screenshotBase64List = req.files.map(file => {
      return `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
    });

    // 更新订单的截图列表
    const updatedOrder = await Order.findOneAndUpdate(
      { orderId },
      { $push: { payScreenshots: { $each: screenshotBase64List } } },
      { new: true, upsert: false } // new:返回更新后的数据；upsert:不存在则不创建
    );

    if (!updatedOrder) {
      return res.json({ code: -1, msg: '订单不存在' });
    }

    res.json({
      code: 0,
      msg: `成功上传 ${screenshotBase64List.length} 张截图`,
      data: {
        orderId,
        screenshots: screenshotBase64List // 返回Base64列表（前端可预览）
      }
    });
  } catch (error) {
    console.error('上传截图失败：', error);
    res.json({ code: -1, msg: '上传失败：' + error.message });
  }
});

/**
 * 提交/追加订单接口
 */
app.post('/api/submitOrder', async (req, res) => {
  try {
    const { userName, userPhone, payType, carList, createTime } = req.body;
    const submitTime = createTime || get24HourTime();

    // 基础校验
    if (!userName || !userPhone || !carList || carList.length === 0) {
      return res.json({ code: -1, msg: '用户名、手机号、车辆信息不能为空' });
    }

    // 查询是否已有该用户订单
    const existingOrder = await Order.findOne({
      userName: userName.trim(),
      userPhone: userPhone.trim()
    });

    if (existingOrder) {
      // 追加订单逻辑
      const oldCarNames = existingOrder.carList.map(i => i.name);
      const newCars = carList.filter(car => !oldCarNames.includes(car.name));
      const mergedCars = sortCarList([...existingOrder.carList, ...newCars]);
      const newTotal = calculateTotalAmount(mergedCars);

      // 追加支付记录
      existingOrder.paymentRecords.push({
        payType: payType || '-',
        amount: calculateTotalAmount(newCars),
        time: submitTime
      });

      // 更新订单
      await Order.findByIdAndUpdate(existingOrder._id, {
        total: newTotal,
        carList: mergedCars,
        payType: payType || existingOrder.payType,
        createTime: submitTime,
        paymentRecords: existingOrder.paymentRecords,
        lastOperationType: 'submit',
        submittedCarList: mergedCars,
        submitCount: existingOrder.submitCount + 1
      });

      return res.json({
        code: 0,
        msg: '订单追加成功',
        data: { orderId: existingOrder.orderId }
      });
    } else {
      // 新建订单逻辑
      const sortedCars = sortCarList(carList);
      const totalAmount = calculateTotalAmount(sortedCars);
      const orderId = 'ORD' + Date.now();

      const newOrder = new Order({
        userName: userName.trim(),
        userPhone: userPhone.trim(),
        total: totalAmount,
        carList: sortedCars,
        orderId,
        payType: payType || '-',
        createTime: submitTime,
        paymentRecords: [{
          payType: payType || '-',
          amount: totalAmount,
          time: submitTime
        }],
        lastOperationType: 'submit',
        submittedCarList: sortedCars,
        payScreenshots: [], // 初始无截图
        submitCount: 1
      });

      await newOrder.save();

      res.json({
        code: 0,
        msg: '订单创建成功',
        data: { orderId }
      });
    }
  } catch (error) {
    console.error('提交订单失败：', error);
    res.json({ code: -1, msg: '提交失败：' + error.message });
  }
});

/**
 * 查询单个用户订单
 */
app.get('/api/queryOrder', async (req, res) => {
  try {
    const { userName } = req.query;
    if (!userName) {
      return res.json({ code: -1, msg: '请传入用户名' });
    }

    const orders = await Order.find({ userName: userName.trim() });
    const formattedOrders = orders.map(order => ({
      ...order.toObject(),
      carList: sortCarList(order.carList || []),
      total: calculateTotalAmount(order.carList || []),
      isManuallyModified: isCarListModified(order.submittedCarList, order.carList),
      isMultiSubmit: order.submitCount > 1
    }));

    res.json({
      code: 0,
      msg: '查询成功',
      data: formattedOrders
    });
  } catch (error) {
    console.error('查询订单失败：', error);
    res.json({ code: -1, msg: '查询失败：' + error.message });
  }
});

/**
 * 管理员获取所有订单
 */
app.get('/api/getAllOrders', adminAuth, async (req, res) => {
  try {
    const orders = await Order.find().sort({ _id: -1 }); // 按创建时间倒序
    const formattedOrders = orders.map(order => ({
      ...order.toObject(),
      id: order._id.toString(),
      carList: sortCarList(order.carList || []),
      total: calculateTotalAmount(order.carList || []),
      isManuallyModified: isCarListModified(order.submittedCarList, order.carList),
      isMultiSubmit: order.submitCount > 1
    }));

    res.json({
      code: 0,
      msg: '获取所有订单成功',
      data: formattedOrders
    });
  } catch (error) {
    console.error('获取所有订单失败：', error);
    res.json({ code: -1, msg: '获取失败：' + error.message });
  }
});

/**
 * 管理员删除订单
 */
app.post('/api/deleteOrder', adminAuth, async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) {
      return res.json({ code: -1, msg: '请传入订单ID' });
    }

    const deletedOrder = await Order.findByIdAndDelete(id);
    if (!deletedOrder) {
      return res.json({ code: -1, msg: '订单不存在' });
    }

    res.json({ code: 0, msg: '订单删除成功' });
  } catch (error) {
    console.error('删除订单失败：', error);
    res.json({ code: -1, msg: '删除失败：' + error.message });
  }
});

/**
 * 管理员刷新订单金额
 */
app.post('/api/recalculateAmount', adminAuth, async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) {
      return res.json({ code: -1, msg: '请传入订单号' });
    }

    const order = await Order.findOne({ orderId });
    if (!order) {
      return res.json({ code: -1, msg: '订单不存在' });
    }

    const newTotal = calculateTotalAmount(order.carList || []);
    await Order.findByIdAndUpdate(order._id, {
      total: newTotal,
      lastOperationType: 'modify'
    });

    res.json({
      code: 0,
      msg: '金额刷新成功',
      data: { newTotal }
    });
  } catch (error) {
    console.error('刷新金额失败：', error);
    res.json({ code: -1, msg: '刷新失败：' + error.message });
  }
});

/**
 * 兼容旧的删除接口（GET方式）
 */
app.delete('/api/deleteOrder', async (req, res) => {
  try {
    const { orderId } = req.query;
    if (!orderId) {
      return res.json({ code: -1, msg: '缺少订单号' });
    }

    const deletedOrder = await Order.findOneAndDelete({ orderId });
    if (!deletedOrder) {
      return res.json({ code: -1, msg: '订单不存在' });
    }

    res.json({ code: 0, msg: '订单删除成功' });
  } catch (error) {
    console.error('删除订单（GET）失败：', error);
    res.json({ code: -1, msg: '删除失败：' + error.message });
  }
});

// ====================== 启动服务 ======================
const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`✅ 服务已启动，端口：${port}`);
  console.log(`✅ 接口文档：POST /api/uploadScreenshot（上传截图）`);
});

// ====================== 全局异常捕获 ======================
// 捕获未处理的异常
process.on('uncaughtException', (err) => {
  console.error('❌ 未捕获的异常：', err);
  setTimeout(() => process.exit(1), 3000);
});

// 捕获未处理的Promise拒绝
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ 未处理的Promise拒绝：', reason, promise);
  setTimeout(() => process.exit(1), 3000);
});
