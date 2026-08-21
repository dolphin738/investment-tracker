from app.modules.admin.router import router_admin
from app.modules.admin.schedule import router_admin_schedule
from app.modules.admin.log_center import router_admin_log_center

__all__ = ["router_admin", "router_admin_schedule", "router_admin_log_center"]