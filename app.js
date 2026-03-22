const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const rateLimit = require('express-rate-limit'); // 新增：接口限流
const app = express();
const PORT = process.env.PORT || 3000;

// ====================== 核心配置 ======================
app.use(cors());
app.use(express.json({ limit: '50mb' })); // 支持大体积Base64数据
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// 管理员接口限流：1分钟最多5次请求（防止暴力破解）
const adminLimiter = rateLimit({
  windowMs: 60 * 1000, // 1分钟
  max: 5, // 最多5次请求
  message: { code: -1, msg: '请求过于频繁，请稍后再试' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ====================== MongoDB 模型定义 ======================
const orderSchema = new mongoose.Schema({
  orderId: { type: String, unique: true, required: true },
  userName: { type: String, required: true },
  userPhone: { type: String, required: true },
  total: { type: Number, required: true },
  carList: [{
    name: String,
    price: String,
    school: String,
    from: String,
    to: String
  }],
  payType: { type: String, required: true },
  createTime: { type: String, required: true },
  payScreenshots: [{ type: String }], // 存储Base64格式截图
  paymentRecords: [{
    payType: String,
    amount: Number,
    time: String
  }],
  isManuallyModified: { type: Boolean, default: false }, // 手动修改标记
  isMultiSubmit: { type: Boolean, default: false } // 多次提交标记
});

const Order = mongoose.model('Order', orderSchema);

// ====================== 数据库连接 ======================
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB 连接成功'))
  .catch(err => console.error('MongoDB 连接失败:', err));

// ====================== 工具函数 ======================
// 生成唯一订单号
function generateOrderId() {
  const date = new Date();
  const dateStr = date.getFullYear().toString() + 
                  String(date.getMonth() + 1).padStart(2, '0') + 
                  String(date.getDate()).padStart(2, '0');
  const randomStr = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `SQY${dateStr}${randomStr}`;
}

// ====================== 核心接口（修复密码传输） ======================
/**
 * 1. 管理员获取所有订单（POST请求，密码放请求体）
 */
app.post('/api/getAllOrders', adminLimiter, async (req, res) => {
  try {
    // 从请求体获取密码，而非URL参数
    const { pwd } = req.body;
    if (pwd !== process.env.ADMIN_PWD) {
      return res.json({ code: -1, msg: '密码错误' });
    }
    const orders = await Order.find().sort({ createTime: -1 });
    res.json({ code: 0, data: orders });
  } catch (err) {
    console.error('获取订单失败:', err);
    res.json({ code: -1, msg: '获取订单失败' });
  }
});

/**
 * 2. 用户提交订单
 */
app.post('/api/submitOrder', async (req, res) => {
  try {
    const { userName, userPhone, total, carList, payType, createTime } = req.body;
    
    // 验证必填参数
    if (!userName || !userPhone || !total || !carList || !payType || !createTime) {
      return res.json({ code: -1, msg: '参数不全' });
    }

    // 检查是否重复提交（相同手机号+相同班次）
    const existingOrder = await Order.findOne({
      userPhone,
      'carList.name': { $in: carList.map(item => item.name) }
    });

    let orderId = generateOrderId();
    // 多次提交标记
    const isMultiSubmit = !!existingOrder;

    // 创建新订单
    const newOrder = new Order({
      orderId,
      userName,
      userPhone,
      total,
      carList,
      payType,
      createTime,
      isMultiSubmit,
      payScreenshots: [],
      paymentRecords: [{ payType, amount: total, time: createTime }]
    });

    await newOrder.save();
    res.json({ code: 0, msg: '提交成功', orderId });
  } catch (err) {
    console.error('提交订单失败:', err);
    res.json({ code: -1, msg: '提交失败，请重试' });
  }
});

/**
 * 3. 上传支付截图（转Base64存储）
 */
app.post('/api/uploadScreenshot', async (req, res) => {
  try {
    const { orderId, screenshots } = req.body; // 前端传Base64数组
    
    if (!orderId || !screenshots || !Array.isArray(screenshots)) {
      return res.json({ code: -1, msg: '参数错误' });
    }

    const order = await Order.findOne({ orderId });
    if (!order) {
      return res.json({ code: -1, msg: '订单不存在' });
    }

    // 追加Base64截图（去重）
    const uniqueScreenshots = [...new Set([...order.payScreenshots, ...screenshots])];
    order.payScreenshots = uniqueScreenshots;
    await order.save();

    res.json({ code: 0, msg: '截图上传成功' });
  } catch (err) {
    console.error('上传截图失败:', err);
    res.json({ code: -1, msg: '截图上传失败' });
  }
});

/**
 * 4. 管理员刷新订单金额
 */
app.post('/api/recalculateAmount', adminLimiter, async (req, res) => {
  try {
    const { pwd, orderId } = req.body;
    if (pwd !== process.env.ADMIN_PWD) {
      return res.json({ code: -1, msg: '密码错误' });
    }

    const order = await Order.findOne({ orderId });
    if (!order) {
      return res.json({ code: -1, msg: '订单不存在' });
    }

    // 重新计算金额
    let newTotal = 0;
    order.carList.forEach(item => {
      newTotal += Number(item.price);
    });
    order.total = newTotal;
    order.isManuallyModified = true; // 标记为手动修改
    await order.save();

    res.json({ code: 0, msg: `金额刷新成功，新金额：${newTotal}元` });
  } catch (err) {
    console.error('刷新金额失败:', err);
    res.json({ code: -1, msg: '刷新金额失败' });
  }
});

/**
 * 5. 管理员删除订单
 */
app.post('/api/deleteOrder', adminLimiter, async (req, res) => {
  try {
    const { pwd, id } = req.body;
    if (pwd !== process.env.ADMIN_PWD) {
      return res.json({ code: -1, msg: '密码错误' });
    }

    const result = await Order.findByIdAndDelete(id);
    if (!result) {
      return res.json({ code: -1, msg: '订单不存在' });
    }

    res.json({ code: 0, msg: '订单删除成功' });
  } catch (err) {
    console.error('删除订单失败:', err);
    res.json({ code: -1, msg: '删除订单失败' });
  }
});

/**
 * 6. 用户查询订单
 */
app.get('/api/queryOrder', async (req, res) => {
  try {
    const { userName } = req.query;
    if (!userName) {
      return res.json({ code: -1, msg: '请输入姓名' });
    }

    const orders = await Order.find({ userName: new RegExp(userName) }).sort({ createTime: -1 });
    res.json({ code: 0, data: orders });
  } catch (err) {
    console.error('查询订单失败:', err);
    res.json({ code: -1, msg: '查询失败' });
  }
});

// ====================== 启动服务 ======================
app.listen(PORT, () => {
  console.log(`服务器运行在端口 ${PORT}`);
});
