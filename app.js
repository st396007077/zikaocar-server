// 打开修改订单弹窗
function openModifyModal(id, orderId) {
  // 找到对应的订单数据
  const originalOrder = originalOrderData.find(order => order._id === id);
  if (!originalOrder) {
    showModal('错误', '找不到订单数据');
    return;
  }
  
  // 填充数据
  document.getElementById('modifyOrderId').innerText = orderId;
  document.getElementById('modifyCarList').value = JSON.stringify(originalOrder.carList || [], null, 2);
  document.getElementById('modifyPassword').value = '';
  
  // 显示弹窗
  document.getElementById('modifyModal').style.display = 'flex';
}

// 关闭修改弹窗
function closeModifyModal() {
  document.getElementById('modifyModal').style.display = 'none';
}

// 提交修改
async function submitModifyOrder() {
  const orderId = document.getElementById('modifyOrderId').innerText;
  const carListStr = document.getElementById('modifyCarList').value;
  const password = document.getElementById('modifyPassword').value;
  
  if (!password) {
    showModal('提示', '请输入管理密码');
    return;
  }
  
  // 验证JSON格式
  let carList;
  try {
    carList = JSON.parse(carListStr);
    if (!Array.isArray(carList)) {
      throw new Error('必须是数组格式');
    }
  } catch (e) {
    showModal('格式错误', '请检查JSON格式是否正确');
    return;
  }
  
  showLoading("正在修改...");
  try {
    const response = await fetch(`${SERVER_URL}/api/updateOrder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pwd: password,
        orderId: orderId,
        updates: {
          carList: carList
        }
      })
    });
    
    const data = await response.json();
    hideLoading();
    
    if (data.code === 0) {
      showModal('修改成功', '订单修改完成，该行将自动标记为红色');
      closeModifyModal();
      load(); // 重新加载数据
    } else {
      showModal('修改失败', data.msg || '未知错误');
    }
  } catch (error) {
    hideLoading();
    showModal('网络错误', '修改失败，请检查网络连接');
  }
}

// 添加单个班次修改的函数
async function openModifyCarItemModal(id, orderId, carIndex) {
  const originalOrder = originalOrderData.find(order => order._id === id);
  if (!originalOrder || !originalOrder.carList || !originalOrder.carList[carIndex]) {
    showModal('错误', '找不到班次信息');
    return;
  }
  
  const carItem = originalOrder.carList[carIndex];
  const modifyContent = `
<div style="text-align: left; margin: 20px 0;">
  <p><strong>班次：</strong>${carItem.name}</p>
  <p><strong>价格：</strong><input type="text" id="modifyPrice" value="${carItem.price}" style="width: 80px; padding: 5px;"></p>
  <p><strong>学校：</strong><input type="text" id="modifySchool" value="${carItem.school || ''}" placeholder="单程班次填写学校" style="width: 200px; padding: 5px;"></p>
  <p><strong>出发学校：</strong><input type="text" id="modifyFrom" value="${carItem.from || ''}" placeholder="考点更换班次填写出发学校" style="width: 200px; padding: 5px;"></p>
  <p><strong>到达学校：</strong><input type="text" id="modifyTo" value="${carItem.to || ''}" placeholder="考点更换班次填写到达学校" style="width: 200px; padding: 5px;"></p>
  <p><strong>管理密码：</strong><input type="password" id="modifyCarPassword" placeholder="请输入管理密码" style="width: 200px; padding: 5px;"></p>
</div>`;
  
  if (confirm(`修改 ${carItem.name} 的信息？\n${modifyContent}`)) {
    const price = document.getElementById('modifyPrice').value;
    const school = document.getElementById('modifySchool').value;
    const from = document.getElementById('modifyFrom').value;
    const to = document.getElementById('modifyTo').value;
    const password = document.getElementById('modifyCarPassword').value;
    
    if (!password) {
      showModal('提示', '请输入管理密码');
      return;
    }
    
    const updates = {};
    if (price) updates.price = price;
    if (school) updates.school = school;
    if (from) updates.from = from;
    if (to) updates.to = to;
    
    showLoading("正在修改...");
    try {
      const response = await fetch(`${SERVER_URL}/api/updateCarItem`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pwd: password,
          orderId: orderId,
          carIndex: carIndex,
          updates: updates
        })
      });
      
      const data = await response.json();
      hideLoading();
      
      if (data.code === 0) {
        showModal('修改成功', '班次修改完成');
        load(); // 重新加载数据
      } else {
        showModal('修改失败', data.msg || '未知错误');
      }
    } catch (error) {
      hideLoading();
      showModal('网络错误', '修改失败');
    }
  }
}
