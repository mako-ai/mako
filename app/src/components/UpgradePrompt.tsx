/**
 * UpgradePrompt Component
 * Modal prompting free-tier users to upgrade for premium model access
 */

import React from "react";
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Typography,
  Box,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
} from "@mui/material";
import { Sparkles, Zap, BarChart3, Shield } from "lucide-react";

interface UpgradePromptProps {
  open: boolean;
  onClose: () => void;
}

const DEMO_URL =
  import.meta.env.VITE_DEMO_BOOKING_URL || "https://calendly.com/mako-ai/demo";

const BENEFITS = [
  {
    icon: <Sparkles size={18} />,
    text: "Access to premium AI models (Claude Opus, GPT-5.2, and more)",
  },
  {
    icon: <Zap size={18} />,
    text: "Higher rate limits and priority inference",
  },
  {
    icon: <BarChart3 size={18} />,
    text: "Advanced analytics and usage insights",
  },
  {
    icon: <Shield size={18} />,
    text: "Priority support and dedicated onboarding",
  },
];

export const UpgradePrompt: React.FC<UpgradePromptProps> = ({
  open,
  onClose,
}) => {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ pb: 0 }}>
        <Typography variant="h6" fontWeight={600}>
          Upgrade to Pro
        </Typography>
      </DialogTitle>
      <DialogContent>
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ mt: 1, mb: 2 }}
        >
          Unlock the most powerful AI models and advanced features for your
          workspace.
        </Typography>
        <List dense disablePadding>
          {BENEFITS.map((b, i) => (
            <ListItem key={i} disableGutters sx={{ py: 0.5 }}>
              <ListItemIcon sx={{ minWidth: 32, color: "primary.main" }}>
                {b.icon}
              </ListItemIcon>
              <ListItemText
                primary={b.text}
                primaryTypographyProps={{ variant: "body2" }}
              />
            </ListItem>
          ))}
        </List>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} color="inherit" size="small">
          Maybe later
        </Button>
        <Box sx={{ flex: 1 }} />
        <Button
          variant="contained"
          href={DEMO_URL}
          target="_blank"
          rel="noopener noreferrer"
          size="small"
        >
          Book a Demo
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default UpgradePrompt;
