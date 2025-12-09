import { useEffect, useState } from "react";
import {
  Box,
  Card,
  CardContent,
  Typography,
  Grid,
  Chip,
  CircularProgress,
  Alert,
  List,
  ListItem,
  ListItemText,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TablePagination,
  IconButton,
  Tooltip,
} from "@mui/material";
import {
  CheckCircle as SuccessIcon,
  Error as ErrorIcon,
  Pending as PendingIcon,
  Refresh as RefreshIcon,
  Visibility as ViewIcon,
  Replay as RetryIcon,
  EditOutlined as EditIcon,
} from "@mui/icons-material";
import { formatDistanceToNow } from "date-fns";
import { apiClient } from "../lib/api-client";

interface WebhookStatsProps {
  workspaceId: string;
  flowId: string;
  onEdit?: () => void;
}

interface WebhookEvent {
  id: string;
  eventId: string;
  eventType: string;
  receivedAt: string;
  processedAt?: string;
  status: "pending" | "processing" | "completed" | "failed";
  attempts: number;
  error?: any;
  processingDurationMs?: number;
}

interface WebhookStats {
  webhookUrl: string;
  lastReceived: string | null;
  totalReceived: number;
  eventsToday: number;
  successRate: number;
  recentEvents: WebhookEvent[];
}

export function WebhookStats({
  workspaceId,
  flowId,
  onEdit,
}: WebhookStatsProps) {
  const [stats, setStats] = useState<WebhookStats | null>(null);
  const [events, setEvents] = useState<WebhookEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<WebhookEvent | null>(null);
  const [eventDialogOpen, setEventDialogOpen] = useState(false);
  const [eventDetails, setEventDetails] = useState<any>(null);

  // Pagination state
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(10);
  const [totalEvents, setTotalEvents] = useState(0);

  const fetchStats = async () => {
    try {
      setError(null);
      const response = await apiClient.get<{
        success: boolean;
        data: WebhookStats;
      }>(`/workspaces/${workspaceId}/flows/${flowId}/webhook/stats`);

      if (response.success && response.data) {
        setStats(response.data);
      }
    } catch (err) {
      console.error("Failed to fetch webhook stats:", err);
      setError("Failed to load webhook statistics");
    }
  };

  const fetchEvents = async () => {
    try {
      const response = await apiClient.get<{
        success: boolean;
        data: {
          total: number;
          events: WebhookEvent[];
        };
      }>(
        `/workspaces/${workspaceId}/flows/${flowId}/webhook/events?limit=${rowsPerPage}&offset=${page * rowsPerPage}`,
      );

      if (response.success && response.data) {
        setEvents(response.data.events);
        setTotalEvents(response.data.total);
      }
    } catch (err) {
      console.error("Failed to fetch webhook events:", err);
    } finally {
      setLoading(false);
    }
  };

  const fetchEventDetails = async (eventId: string) => {
    try {
      const response = await apiClient.get(
        `/workspaces/${workspaceId}/flows/${flowId}/webhook/events/${eventId}`,
      );

      if (response.success && response.data) {
        setEventDetails(response.data);
      }
    } catch (err) {
      console.error("Failed to fetch event details:", err);
    }
  };

  const retryEvent = async (eventId: string) => {
    try {
      const response = await apiClient.post(
        `/workspaces/${workspaceId}/flows/${flowId}/webhook/events/${eventId}/retry`,
      );

      if (response.success) {
        // Refresh the events list
        await fetchEvents();
      }
    } catch (err) {
      console.error("Failed to retry event:", err);
      setError("Failed to retry webhook event");
    }
  };

  useEffect(() => {
    fetchStats();
    fetchEvents();
  }, [workspaceId, flowId, page, rowsPerPage]);

  const handleRefresh = () => {
    setLoading(true);
    fetchStats();
    fetchEvents();
  };

  const handleViewEvent = async (event: WebhookEvent) => {
    setSelectedEvent(event);
    setEventDialogOpen(true);
    await fetchEventDetails(event.id);
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "completed":
        return <SuccessIcon color="success" fontSize="small" />;
      case "failed":
        return <ErrorIcon color="error" fontSize="small" />;
      case "processing":
        return <CircularProgress size={16} />;
      default:
        return <PendingIcon color="warning" fontSize="small" />;
    }
  };

  const getStatusChip = (status: string) => {
    const statusConfig = {
      completed: { color: "success" as const, label: "Completed" },
      failed: { color: "error" as const, label: "Failed" },
      processing: { color: "info" as const, label: "Processing" },
      pending: { color: "warning" as const, label: "Pending" },
    };

    const config = statusConfig[status as keyof typeof statusConfig] || {
      color: "default" as const,
      label: status,
    };

    return <Chip size="small" color={config.color} label={config.label} />;
  };

  if (loading && !stats) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", p: 3 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error) {
    return (
      <Alert severity="error" sx={{ m: 2 }}>
        {error}
      </Alert>
    );
  }

  return (
    <Box sx={{ p: 2 }}>
      {/* Stats Overview */}
      {stats && (
        <Grid container spacing={2} sx={{ mb: 3 }}>
          <Grid item xs={12} md={3}>
            <Card>
              <CardContent>
                <Typography color="text.secondary" gutterBottom>
                  Total Events
                </Typography>
                <Typography variant="h4">{stats.totalReceived}</Typography>
              </CardContent>
            </Card>
          </Grid>
          <Grid item xs={12} md={3}>
            <Card>
              <CardContent>
                <Typography color="text.secondary" gutterBottom>
                  Events Today
                </Typography>
                <Typography variant="h4">{stats.eventsToday}</Typography>
              </CardContent>
            </Card>
          </Grid>
          <Grid item xs={12} md={3}>
            <Card>
              <CardContent>
                <Typography color="text.secondary" gutterBottom>
                  Success Rate
                </Typography>
                <Typography variant="h4">{stats.successRate}%</Typography>
              </CardContent>
            </Card>
          </Grid>
          <Grid item xs={12} md={3}>
            <Card>
              <CardContent>
                <Typography color="text.secondary" gutterBottom>
                  Last Received
                </Typography>
                <Typography variant="body2">
                  {stats.lastReceived
                    ? formatDistanceToNow(new Date(stats.lastReceived), {
                        addSuffix: true,
                      })
                    : "Never"}
                </Typography>
              </CardContent>
            </Card>
          </Grid>
        </Grid>
      )}

      {/* Events Table */}
      <Box
        sx={{
          mb: 2,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <Typography variant="h6">Recent Events</Typography>
        <Box sx={{ display: "flex", gap: 1 }}>
          {onEdit && (
            <Button
              startIcon={<EditIcon />}
              onClick={onEdit}
              variant="outlined"
            >
              Edit
            </Button>
          )}
          <Button
            startIcon={<RefreshIcon />}
            onClick={handleRefresh}
            disabled={loading}
          >
            Refresh
          </Button>
        </Box>
      </Box>

      <TableContainer>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Status</TableCell>
              <TableCell>Event Type</TableCell>
              <TableCell>Event ID</TableCell>
              <TableCell>Received</TableCell>
              <TableCell>Duration</TableCell>
              <TableCell>Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {events.map(event => (
              <TableRow key={event.id}>
                <TableCell>{getStatusChip(event.status)}</TableCell>
                <TableCell>
                  <Typography variant="body2">{event.eventType}</Typography>
                </TableCell>
                <TableCell>
                  <Typography
                    variant="body2"
                    sx={{ fontFamily: "monospace", fontSize: "0.85em" }}
                  >
                    {event.eventId}
                  </Typography>
                </TableCell>
                <TableCell>
                  <Typography variant="body2">
                    {formatDistanceToNow(new Date(event.receivedAt), {
                      addSuffix: true,
                    })}
                  </Typography>
                </TableCell>
                <TableCell>
                  {event.processingDurationMs && (
                    <Typography variant="body2">
                      {event.processingDurationMs}ms
                    </Typography>
                  )}
                </TableCell>
                <TableCell>
                  <Tooltip title="View Details">
                    <IconButton
                      size="small"
                      onClick={() => handleViewEvent(event)}
                    >
                      <ViewIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  {event.status === "failed" && (
                    <Tooltip title="Retry">
                      <IconButton
                        size="small"
                        onClick={() => retryEvent(event.id)}
                      >
                        <RetryIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>

      <TablePagination
        component="div"
        count={totalEvents}
        page={page}
        onPageChange={(_, newPage) => setPage(newPage)}
        rowsPerPage={rowsPerPage}
        onRowsPerPageChange={e => {
          setRowsPerPage(parseInt(e.target.value, 10));
          setPage(0);
        }}
      />

      {/* Event Details Dialog */}
      <Dialog
        open={eventDialogOpen}
        onClose={() => {
          setEventDialogOpen(false);
          setEventDetails(null);
        }}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>
          Webhook Event Details
          {selectedEvent && (
            <Box sx={{ mt: 1 }}>{getStatusChip(selectedEvent.status)}</Box>
          )}
        </DialogTitle>
        <DialogContent>
          {eventDetails ? (
            <Box>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>
                Event Information
              </Typography>
              <List dense>
                <ListItem>
                  <ListItemText
                    primary="Event ID"
                    secondary={eventDetails.eventId}
                  />
                </ListItem>
                <ListItem>
                  <ListItemText
                    primary="Event Type"
                    secondary={eventDetails.eventType}
                  />
                </ListItem>
                <ListItem>
                  <ListItemText
                    primary="Received At"
                    secondary={new Date(
                      eventDetails.receivedAt,
                    ).toLocaleString()}
                  />
                </ListItem>
                {eventDetails.processedAt && (
                  <ListItem>
                    <ListItemText
                      primary="Processed At"
                      secondary={new Date(
                        eventDetails.processedAt,
                      ).toLocaleString()}
                    />
                  </ListItem>
                )}
                <ListItem>
                  <ListItemText
                    primary="Attempts"
                    secondary={eventDetails.attempts}
                  />
                </ListItem>
              </List>

              {eventDetails.error && (
                <>
                  <Typography variant="subtitle2" sx={{ mt: 2, mb: 1 }}>
                    Error Details
                  </Typography>
                  <Alert severity="error">
                    <Typography variant="body2">
                      {eventDetails.error.message}
                    </Typography>
                    {eventDetails.error.stack && (
                      <Typography
                        variant="body2"
                        sx={{
                          mt: 1,
                          fontFamily: "monospace",
                          fontSize: "0.85em",
                        }}
                      >
                        {eventDetails.error.stack}
                      </Typography>
                    )}
                  </Alert>
                </>
              )}

              <Typography variant="subtitle2" sx={{ mt: 2, mb: 1 }}>
                Raw Payload
              </Typography>
              <Box
                sx={{
                  bgcolor: "background.paper",
                  p: 2,
                  borderRadius: 1,
                  border: 1,
                  borderColor: "divider",
                  maxHeight: 400,
                  overflow: "auto",
                }}
              >
                <pre style={{ margin: 0, fontSize: "0.85em" }}>
                  {JSON.stringify(eventDetails.rawPayload, null, 2)}
                </pre>
              </Box>
            </Box>
          ) : (
            <Box sx={{ display: "flex", justifyContent: "center", p: 3 }}>
              <CircularProgress />
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEventDialogOpen(false)}>Close</Button>
          {selectedEvent?.status === "failed" && (
            <Button
              variant="contained"
              startIcon={<RetryIcon />}
              onClick={() => {
                retryEvent(selectedEvent.id);
                setEventDialogOpen(false);
              }}
            >
              Retry Event
            </Button>
          )}
        </DialogActions>
      </Dialog>
    </Box>
  );
}
